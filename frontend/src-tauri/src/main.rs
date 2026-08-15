use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use sysinfo::{Pid, Process, ProcessesToUpdate, System};
use tar::Archive;
use tauri::{Emitter, Manager, State};

struct BackendState {
    session_id: String,
    api_base_url: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
    boot_progress: Mutex<BootProgress>,
    usage_system: Mutex<System>,
}

impl Default for BackendState {
    fn default() -> Self {
        Self {
            session_id: chrono_like_timestamp().to_string(),
            api_base_url: Mutex::new(None),
            child: Mutex::new(None),
            last_error: Mutex::new(None),
            boot_progress: Mutex::new(BootProgress::default()),
            usage_system: Mutex::new(System::new_all()),
        }
    }
}

impl BackendState {
    fn stop(&self) {
        if let Some(mut child) = self.child.lock().expect("backend child mutex").take() {
            terminate_launcher(&mut child);
        }
    }
}

fn terminate_launcher(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-INT")
            .arg(child.id().to_string())
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }

    for _ in 0..50 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Clone, Serialize)]
struct BootProgress {
    progress: u8,
    stage: String,
    detail: String,
}

impl Default for BootProgress {
    fn default() -> Self {
        Self {
            progress: 5,
            stage: "初始化桌面窗口".to_string(),
            detail: "正在创建应用窗口".to_string(),
        }
    }
}

#[derive(Deserialize)]
struct LauncherEvent {
    event: String,
    api_base_url: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
struct DesktopDownloadEvent {
    id: String,
    filename: Option<String>,
    saved_path: Option<String>,
    loaded: u64,
    total: u64,
    status: String,
    error: Option<String>,
}

#[derive(Serialize)]
struct DesktopDownloadStart {
    id: String,
}

#[derive(Clone, Serialize)]
struct ResourceUsage {
    app_cpu_percent: f32,
    app_memory_bytes: u64,
    used_memory_bytes: u64,
    total_memory_bytes: u64,
    used_memory_percent: f32,
    top_processes: Vec<ResourceProcess>,
}

#[derive(Clone, Serialize)]
struct ResourceProcess {
    pid: u32,
    parent_pid: u32,
    name: String,
    cpu_percent: f32,
    memory_bytes: u64,
    command: String,
    can_terminate: bool,
    group: String,
    session: String,
}

#[derive(Serialize)]
struct TerminateProcessResult {
    message: String,
    pids: Vec<u32>,
    process_groups: Vec<u32>,
}

fn emit_boot_progress(
    app: &tauri::AppHandle,
    state: &Arc<BackendState>,
    progress: u8,
    stage: &str,
    detail: &str,
) {
    let payload = BootProgress {
        progress: progress.min(100),
        stage: stage.to_string(),
        detail: detail.to_string(),
    };
    if let Ok(mut slot) = state.boot_progress.lock() {
        *slot = payload.clone();
    }
    let _ = app.emit("boot-progress", payload);
}

#[tauri::command]
fn get_api_base_url(state: State<'_, Arc<BackendState>>) -> Result<String, String> {
    for _ in 0..300 {
        if let Some(url) = state
            .api_base_url
            .lock()
            .map_err(|_| "无法读取后端状态".to_string())?
            .clone()
        {
            return Ok(url);
        }
        if let Some(message) = state
            .last_error
            .lock()
            .map_err(|_| "无法读取后端错误".to_string())?
            .clone()
        {
            return Err(message);
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("后端启动超时，请检查桌面应用日志。".to_string())
}

#[tauri::command]
fn get_boot_progress(state: State<'_, Arc<BackendState>>) -> Result<BootProgress, String> {
    state
        .boot_progress
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "无法读取启动进度。".to_string())
}

#[tauri::command]
fn get_resource_usage(state: State<'_, Arc<BackendState>>) -> Result<ResourceUsage, String> {
    let mut system = state
        .usage_system
        .lock()
        .map_err(|_| "无法读取资源占用状态。".to_string())?;
    system.refresh_memory();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let root_pid = Pid::from_u32(std::process::id());
    let current_session = state.session_id.clone();
    let mut app_cpu = 0.0f32;
    let mut app_memory = 0u64;
    let mut top_processes = Vec::new();
    for (pid, process) in system.processes() {
        let is_app_process = *pid == root_pid || is_descendant_process(&system, *pid, root_pid);
        let is_managed_residual = !is_app_process && looks_like_managed_process(process);
        if is_app_process || is_managed_residual {
            let cpu = process.cpu_usage();
            let memory = process.memory();
            if is_app_process {
                app_cpu += cpu;
                app_memory = app_memory.saturating_add(memory);
            }
            let command = process_command(process);
            let envs = process_env(process);
            let proc_session = envs
                .get("MUSIC_STUDIO_SESSION_ID")
                .cloned()
                .unwrap_or_default();
            let session = if proc_session == current_session {
                "当前批次".to_string()
            } else if proc_session.is_empty() {
                if is_app_process {
                    "当前批次".to_string()
                } else {
                    "残留进程".to_string()
                }
            } else {
                format!("旧批次 {proc_session}")
            };
            top_processes.push(ResourceProcess {
                pid: pid.as_u32(),
                parent_pid: process.parent().map(|parent| parent.as_u32()).unwrap_or(0),
                name: process.name().to_string_lossy().to_string(),
                cpu_percent: cpu,
                memory_bytes: memory,
                command,
                can_terminate: *pid != root_pid && (is_app_process || is_managed_residual),
                group: if is_app_process {
                    "应用进程".to_string()
                } else {
                    "残留进程".to_string()
                },
                session,
            });
        }
    }
    top_processes.sort_by(|a, b| {
        a.parent_pid
            .cmp(&b.parent_pid)
            .then_with(|| b.memory_bytes.cmp(&a.memory_bytes))
    });
    let total_memory = system.total_memory();
    let used_memory = system.used_memory();
    let used_percent = if total_memory > 0 {
        used_memory as f32 / total_memory as f32 * 100.0
    } else {
        0.0
    };
    Ok(ResourceUsage {
        app_cpu_percent: app_cpu,
        app_memory_bytes: app_memory,
        used_memory_bytes: used_memory,
        total_memory_bytes: total_memory,
        used_memory_percent: used_percent,
        top_processes,
    })
}

#[tauri::command]
fn terminate_resource_process(
    state: State<'_, Arc<BackendState>>,
    pid: u32,
) -> Result<TerminateProcessResult, String> {
    let target = Pid::from_u32(pid);
    let root_pid = Pid::from_u32(std::process::id());
    if target == root_pid {
        return Err("不能结束桌面主进程，请直接退出应用。".to_string());
    }

    let mut system = state
        .usage_system
        .lock()
        .map_err(|_| "无法读取资源占用状态。".to_string())?;
    system.refresh_processes(ProcessesToUpdate::All, true);
    let process = system
        .process(target)
        .ok_or_else(|| format!("进程 {pid} 已不存在。"))?;
    let allowed =
        is_descendant_process(&system, target, root_pid) || looks_like_managed_process(process);
    if !allowed {
        return Err(
            "出于安全限制，只能结束当前应用子进程或识别为 Music Studio/ACE-Step 的残留进程。"
                .to_string(),
        );
    }
    let mut targets = descendant_pids(&system, target);
    targets.sort_unstable();
    targets.dedup();
    targets.push(pid);
    targets.sort_unstable();
    targets.dedup();
    let groups = safe_process_groups(&targets);
    terminate_pids_and_groups(&targets, &groups)?;
    Ok(TerminateProcessResult {
        message: format!(
            "已结束进程 {} 个，进程组 {} 个。",
            targets.len(),
            groups.len()
        ),
        pids: targets,
        process_groups: groups,
    })
}

fn cleanup_stale_managed_processes(state: &Arc<BackendState>) -> Result<(), String> {
    if env::var("MUSIC_STUDIO_SKIP_STALE_PROCESS_CLEANUP")
        .ok()
        .as_deref()
        == Some("1")
    {
        return Ok(());
    }
    let root_pid = Pid::from_u32(std::process::id());
    let current_session = state.session_id.clone();
    let mut system = state
        .usage_system
        .lock()
        .map_err(|_| "无法读取资源占用状态。".to_string())?;
    system.refresh_processes(ProcessesToUpdate::All, true);

    let mut targets = Vec::new();
    for (pid, process) in system.processes() {
        if *pid == root_pid || is_descendant_process(&system, *pid, root_pid) {
            continue;
        }
        if !looks_like_managed_process(process) {
            continue;
        }
        let envs = process_env(process);
        let proc_session = envs
            .get("MUSIC_STUDIO_SESSION_ID")
            .cloned()
            .unwrap_or_default();
        if proc_session == current_session {
            continue;
        }
        targets.extend(descendant_pids(&system, *pid));
        targets.push(pid.as_u32());
    }
    targets.sort_unstable();
    targets.dedup();
    if targets.is_empty() {
        return Ok(());
    }
    let groups = safe_process_groups(&targets);
    println!(
        "[music-studio-desktop] cleaning stale managed processes: pids={targets:?}, groups={groups:?}"
    );
    terminate_pids_and_groups(&targets, &groups)
}

fn is_descendant_process(system: &System, pid: Pid, ancestor: Pid) -> bool {
    let mut current = Some(pid);
    for _ in 0..64 {
        let Some(pid) = current else {
            return false;
        };
        let Some(process) = system.process(pid) else {
            return false;
        };
        let Some(parent) = process.parent() else {
            return false;
        };
        if parent == ancestor {
            return true;
        }
        current = Some(parent);
    }
    false
}

fn descendant_pids(system: &System, ancestor: Pid) -> Vec<u32> {
    let mut out = Vec::new();
    for pid in system.processes().keys() {
        if is_descendant_process(system, *pid, ancestor) {
            out.push(pid.as_u32());
        }
    }
    out
}

fn process_command(process: &Process) -> String {
    process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
}

fn looks_like_managed_process(process: &Process) -> bool {
    let name = process.name().to_string_lossy().to_lowercase();
    let command = process_command(process).to_lowercase();
    let envs = process_env(process);
    name.contains("music-studio")
        || name.contains("acestep")
        || envs.contains_key("MUSIC_STUDIO_SESSION_ID")
        || command.contains("acestep-api")
        || command.contains("launch_acestep_runtime.py")
        || command.contains("desktop_launcher.py")
        || command.contains("app.celery_app.celery_app")
        || command.contains("svc_service")
        || command.contains("com.musicstudio.desktop")
}

fn process_env(process: &Process) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for item in process.environ() {
        let text = item.to_string_lossy();
        if let Some((key, value)) = text.split_once('=') {
            out.insert(key.to_string(), value.to_string());
        }
    }
    out
}

fn terminate_pids_and_groups(pids: &[u32], groups: &[u32]) -> Result<(), String> {
    if pids.is_empty() && groups.is_empty() {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let mut last_error = None;
        for pid in pids {
            let status = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status()
                .map_err(|err| format!("结束进程 {pid} 失败: {err}"))?;
            if !status.success() {
                last_error = Some(format!("结束进程 {pid} 失败，退出码 {:?}", status.code()));
            }
        }
        if let Some(error) = last_error {
            Err(error)
        } else {
            Ok(())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for group in groups {
            let _ = signal_process_group(*group, "-TERM");
        }
        for pid in pids {
            let _ = signal_pid(*pid, "-TERM");
        }
        thread::sleep(Duration::from_millis(700));
        for group in groups {
            if process_group_has_alive_members(*group, pids) {
                let _ = signal_process_group(*group, "-KILL");
            }
        }
        for pid in pids {
            if process_exists(*pid) {
                let _ = signal_pid(*pid, "-KILL");
            }
        }
        let alive = pids
            .iter()
            .copied()
            .filter(|pid| process_exists(*pid))
            .collect::<Vec<_>>();
        if alive.is_empty() {
            Ok(())
        } else {
            Err(format!("部分进程未能结束: {:?}", alive))
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn safe_process_groups(pids: &[u32]) -> Vec<u32> {
    let current_group = process_group_id(std::process::id()).unwrap_or(0);
    let mut groups = pids
        .iter()
        .filter_map(|pid| process_group_id(*pid))
        .filter(|pgid| *pgid != 0 && *pgid != current_group)
        .collect::<Vec<_>>();
    groups.sort_unstable();
    groups.dedup();
    groups
}

#[cfg(target_os = "windows")]
fn safe_process_groups(_pids: &[u32]) -> Vec<u32> {
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
fn process_group_id(pid: u32) -> Option<u32> {
    let output = Command::new("ps")
        .args(["-o", "pgid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u32>()
        .ok()
}

#[cfg(not(target_os = "windows"))]
fn signal_process_group(group: u32, signal: &str) -> Result<(), String> {
    let target = format!("-{group}");
    let status = Command::new("kill")
        .args([signal, &target])
        .status()
        .map_err(|err| format!("发送 {signal} 到进程组 {group} 失败: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "发送 {signal} 到进程组 {group} 失败，退出码 {:?}",
            status.code()
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn process_group_has_alive_members(group: u32, pids: &[u32]) -> bool {
    pids.iter()
        .copied()
        .any(|pid| process_exists(pid) && process_group_id(pid) == Some(group))
}

#[cfg(not(target_os = "windows"))]
fn signal_pid(pid: u32, signal: &str) -> Result<(), String> {
    let status = Command::new("kill")
        .args([signal, &pid.to_string()])
        .status()
        .map_err(|err| format!("发送 {signal} 到进程 {pid} 失败: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "发送 {signal} 到进程 {pid} 失败，退出码 {:?}",
            status.code()
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn process_exists(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn downloads_dir() -> PathBuf {
    if cfg!(target_os = "windows") {
        env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .map(|home| home.join("Downloads"))
            .unwrap_or_else(env::temp_dir)
    } else {
        env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Downloads"))
            .unwrap_or_else(env::temp_dir)
    }
}

fn safe_download_name(name: &str) -> String {
    let value = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ if c.is_control() => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if value.is_empty() {
        "download".to_string()
    } else {
        value
    }
}

fn unique_download_path(dir: &Path, filename: &str) -> PathBuf {
    let path = dir.join(filename);
    if !path.exists() {
        return path;
    }
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("download");
    let ext = Path::new(filename)
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    for index in 1..1000 {
        let candidate = dir.join(format!("{stem} ({index}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}{}", chrono_like_timestamp(), ext))
}

fn chrono_like_timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis())
        .unwrap_or(0)
}

#[tauri::command]
fn save_download_file(filename: String, bytes: Vec<u8>) -> Result<String, String> {
    let dir = downloads_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建下载目录 {}: {err}", dir.display()))?;
    let filename = safe_download_name(&filename);
    let path = unique_download_path(&dir, &filename);
    fs::write(&path, bytes).map_err(|err| format!("保存文件失败 {}: {err}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn create_download_file(filename: String) -> Result<String, String> {
    let dir = downloads_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建下载目录 {}: {err}", dir.display()))?;
    let filename = safe_download_name(&filename);
    let path = unique_download_path(&dir, &filename);
    File::create(&path).map_err(|err| format!("无法创建下载文件 {}: {err}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn append_download_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let path = PathBuf::from(path);
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|err| format!("无法写入下载文件 {}: {err}", path.display()))?;
    file.write_all(&bytes)
        .map_err(|err| format!("写入下载文件失败 {}: {err}", path.display()))
}

#[tauri::command]
fn start_desktop_download(
    app: tauri::AppHandle,
    id: String,
    url: String,
    filename: String,
) -> Result<DesktopDownloadStart, String> {
    if id.trim().is_empty() {
        return Err("下载任务 id 不能为空".to_string());
    }
    if url.trim().is_empty() {
        return Err("下载地址不能为空".to_string());
    }
    let task_id = id.clone();
    thread::spawn(move || {
        if let Err(error) = run_desktop_download(&app, &task_id, &url, &filename) {
            emit_download_event(
                &app,
                DesktopDownloadEvent {
                    id: task_id,
                    filename: None,
                    saved_path: None,
                    loaded: 0,
                    total: 0,
                    status: "failed".to_string(),
                    error: Some(error),
                },
            );
        }
    });
    Ok(DesktopDownloadStart { id })
}

fn run_desktop_download(
    app: &tauri::AppHandle,
    id: &str,
    url: &str,
    fallback_filename: &str,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .build()
        .map_err(|err| format!("初始化下载客户端失败: {err}"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|err| format!("请求下载失败: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败: HTTP {}", response.status()));
    }

    let filename = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(filename_from_content_disposition)
        .unwrap_or_else(|| fallback_filename.to_string());
    let total = response.content_length().unwrap_or(0);
    let dir = downloads_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建下载目录 {}: {err}", dir.display()))?;
    let safe_name = safe_download_name(&filename);
    let path = unique_download_path(&dir, &safe_name);
    let mut file =
        File::create(&path).map_err(|err| format!("无法创建下载文件 {}: {err}", path.display()))?;
    let saved_path = path.to_string_lossy().to_string();

    emit_download_event(
        app,
        DesktopDownloadEvent {
            id: id.to_string(),
            filename: Some(safe_name),
            saved_path: Some(saved_path.clone()),
            loaded: 0,
            total,
            status: "downloading".to_string(),
            error: None,
        },
    );

    let mut loaded = 0u64;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut last_emit = Instant::now();
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|err| format!("读取下载内容失败: {err}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|err| format!("写入下载文件失败 {}: {err}", path.display()))?;
        loaded += read as u64;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            emit_download_event(
                app,
                DesktopDownloadEvent {
                    id: id.to_string(),
                    filename: None,
                    saved_path: Some(saved_path.clone()),
                    loaded,
                    total,
                    status: "downloading".to_string(),
                    error: None,
                },
            );
            last_emit = Instant::now();
        }
    }
    file.flush()
        .map_err(|err| format!("刷新下载文件失败 {}: {err}", path.display()))?;
    emit_download_event(
        app,
        DesktopDownloadEvent {
            id: id.to_string(),
            filename: None,
            saved_path: Some(saved_path),
            loaded,
            total,
            status: "done".to_string(),
            error: None,
        },
    );
    Ok(())
}

fn emit_download_event(app: &tauri::AppHandle, event: DesktopDownloadEvent) {
    let _ = app.emit("desktop-download-progress", event);
}

fn filename_from_content_disposition(value: &str) -> Option<String> {
    for part in value.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=UTF-8''") {
            return Some(percent_decode(rest));
        }
        if let Some(rest) = part.strip_prefix("filename=") {
            return Some(rest.trim_matches('"').to_string());
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(hex);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn main() {
    prepare_home_fallback_for_webkit();
    let backend_state = Arc::new(BackendState::default());

    tauri::Builder::default()
        .manage(backend_state.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = app.state::<Arc<BackendState>>().inner().clone();
            thread::spawn(move || {
                if let Err(err) = cleanup_stale_managed_processes(&state) {
                    eprintln!("[music-studio-desktop] stale process cleanup failed: {err}");
                }
                if let Err(err) = launch_backend(&handle, state.clone()) {
                    if let Ok(mut last_error) = state.last_error.lock() {
                        *last_error = Some(err);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_api_base_url,
            get_boot_progress,
            get_resource_usage,
            terminate_resource_process,
            save_download_file,
            create_download_file,
            append_download_file,
            start_desktop_download
        ])
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                backend_state.stop();
            }
        });
}

fn prepare_home_fallback_for_webkit() {
    if !cfg!(target_os = "macos") {
        return;
    }

    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let probe = home
        .join("Library")
        .join("WebKit")
        .join("music-studio-desktop")
        .join(".write-test");
    if fs::create_dir_all(probe.parent().expect("webkit probe parent")).is_ok()
        && fs::write(&probe, b"ok").is_ok()
    {
        let _ = fs::remove_file(probe);
        return;
    }

    let fallback = env::var_os("MUSIC_STUDIO_WEBKIT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if is_dev_mode() {
                project_root()
                    .map(|root| root.join("desktop-data").join("home"))
                    .unwrap_or_else(|| env::temp_dir().join("music-studio-desktop-home"))
            } else {
                home.join("Library")
                    .join("Application Support")
                    .join("com.musicstudio.desktop")
                    .join("home")
            }
        });
    if fs::create_dir_all(&fallback).is_ok() {
        env::set_var("HOME", fallback);
    }
}

fn launch_backend(app: &tauri::AppHandle, state: Arc<BackendState>) -> Result<(), String> {
    emit_boot_progress(
        app,
        &state,
        8,
        "定位后端资源",
        "正在查找内置 backend 和应用数据目录",
    );
    let backend_dir = locate_backend_dir(app)?;
    let data_dir = desktop_data_dir(app)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|err| format!("无法创建应用数据目录 {}: {err}", data_dir.display()))?;
    emit_boot_progress(
        app,
        &state,
        18,
        "准备 Python runtime",
        "正在检查或解压内置后端运行时",
    );
    let python = locate_or_prepare_python(&backend_dir, &data_dir)?;

    emit_boot_progress(
        app,
        &state,
        42,
        "启动桌面后端",
        "正在启动本地 API、任务队列和 sidecar 管理器",
    );
    let mut command = Command::new(&python);
    command
        .arg("desktop_launcher.py")
        .current_dir(&backend_dir)
        .env("MUSIC_STUDIO_DATA_DIR", &data_dir)
        .env(
            "MUSIC_STUDIO_RUNTIME_MODE",
            if is_dev_mode() {
                "desktop-dev"
            } else {
                "packaged"
            },
        )
        .env(
            "MUSIC_STUDIO_PACKAGED",
            if is_dev_mode() { "0" } else { "1" },
        )
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("MUSIC_STUDIO_SESSION_ID", &state.session_id)
        .env_remove("VIRTUAL_ENV")
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("MUSIC_STUDIO_PYTHON")
        .env_remove("UV_PROJECT_ENVIRONMENT")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if is_dev_mode() {
        if let Some(root) = project_root() {
            command.env("MUSIC_STUDIO_PROJECT_ROOT", &root);
            if env::var_os("APP_ACESTEP_DIR").is_none() {
                command.env(
                    "APP_ACESTEP_DIR",
                    root.join("external").join("ACE-Step-1.5"),
                );
            }
            if env::var_os("ACESTEP_DIR").is_none() {
                command.env("ACESTEP_DIR", root.join("external").join("ACE-Step-1.5"));
            }
            // ACESTEP_SOURCE_ZIP 交由 launch_acestep.sh 解析（settings.resources_dir >
            // <workspace>/resources > 项目内 resources/），此处不再写死默认值，
            // 否则会被误判为“显式指定”而无法响应用户配置的 resources 目录。
        }
    }
    let mut child = command.spawn().map_err(|err| {
        format!(
            "无法启动后端：{}（python: {}, backend: {}）",
            err,
            python.display(),
            backend_dir.display()
        )
    })?;

    emit_boot_progress(
        app,
        &state,
        55,
        "等待后端输出",
        "后端进程已启动，正在等待服务就绪",
    );
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Ok(mut slot) = state.child.lock() {
        *slot = Some(child);
    }

    if let Some(stderr) = stderr {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[music-studio-backend] {line}");
            }
        });
    }

    let Some(stdout) = stdout else {
        return Err("无法读取后端启动输出。".to_string());
    };
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        println!("[music-studio-backend] {line}");
        if let Ok(event) = serde_json::from_str::<LauncherEvent>(&line) {
            match event.event.as_str() {
                "desktop-log" => {
                    emit_boot_progress(
                        app,
                        &state,
                        72,
                        "初始化本地服务",
                        event.message.as_deref().unwrap_or("正在准备本地服务"),
                    );
                }
                "desktop-ready" => {
                    emit_boot_progress(app, &state, 100, "启动完成", "本地后端已就绪");
                    if let Some(url) = event.api_base_url {
                        if let Ok(mut api_base_url) = state.api_base_url.lock() {
                            *api_base_url = Some(url);
                        }
                    }
                }
                "desktop-error" => {
                    if let Some(message) = event.message {
                        emit_boot_progress(app, &state, 100, "启动失败", &message);
                        if let Ok(mut last_error) = state.last_error.lock() {
                            *last_error = Some(message);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn is_dev_mode() -> bool {
    cfg!(debug_assertions)
}

fn project_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn desktop_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if is_dev_mode() {
        return project_root()
            .map(|root| root.join("desktop-data"))
            .ok_or_else(|| "无法推导桌面开发数据目录。".to_string());
    }
    app.path()
        .app_data_dir()
        .map_err(|err| format!("无法确定应用数据目录: {err}"))
}

fn locate_backend_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if is_dev_mode() {
        let dev_backend = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .map(|root| root.join("backend"))
            .ok_or_else(|| "无法推导项目根目录。".to_string())?;
        if dev_backend.join("desktop_launcher.py").is_file() {
            return Ok(dev_backend);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("backend");
        if bundled.join("desktop_launcher.py").is_file() {
            return Ok(bundled);
        }
    }

    if !is_dev_mode() {
        if let Ok(exe) = env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                let portable = exe_dir.join("backend");
                if portable.join("desktop_launcher.py").is_file() {
                    return Ok(portable);
                }
            }
        }
    }

    if !is_dev_mode() {
        return Err("打包应用缺少内置 backend/desktop_launcher.py，请重新打包。".to_string());
    }

    let dev_backend = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(|root| root.join("backend"))
        .ok_or_else(|| "无法推导项目根目录。".to_string())?;
    if dev_backend.join("desktop_launcher.py").is_file() {
        return Ok(dev_backend);
    }

    Err("未找到 backend/desktop_launcher.py。".to_string())
}

fn locate_or_prepare_python(backend_dir: &Path, data_dir: &Path) -> Result<PathBuf, String> {
    if is_dev_mode() {
        if let Some(path) = env::var_os("MUSIC_STUDIO_PYTHON").map(PathBuf::from) {
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    if !is_dev_mode() {
        if let Some(path) = ensure_bundled_runtime(backend_dir, data_dir)? {
            return Ok(path);
        }
    }

    if !is_dev_mode() {
        return Err(
            "打包应用缺少内置 Python runtime。请重新打包：npm run desktop:build 或 npm run desktop:build:dmg"
                .to_string(),
        );
    }

    if let Some(path) = env::var_os("MUSIC_STUDIO_PYTHON").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }

    if let Some(path) = venv_python(&backend_dir.join(".venv")) {
        return Ok(path);
    }

    if let Some(dev_backend) = dev_backend_dir() {
        if let Some(path) = venv_python(&dev_backend.join(".venv")) {
            return Ok(path);
        }
    }

    let runtime_dir = data_dir.join("backend-runtime");
    let runtime_venv = runtime_dir.join(".venv");
    if let Some(path) = venv_python(&runtime_venv) {
        return Ok(path);
    }

    prepare_runtime_venv(backend_dir, &runtime_dir)?;
    venv_python(&runtime_venv).ok_or_else(|| {
        format!(
            "后端运行时准备完成但未找到 Python: {}",
            runtime_venv.display()
        )
    })
}

fn ensure_bundled_runtime(backend_dir: &Path, data_dir: &Path) -> Result<Option<PathBuf>, String> {
    let resource_root = backend_dir.parent().unwrap_or(backend_dir);
    let archive = resource_root
        .join("desktop-runtime")
        .join("backend-runtime.tar.gz");
    if !archive.is_file() {
        return Ok(None);
    }

    let runtime_dir = data_dir.join("bundled-runtime");
    let runtime_venv = runtime_dir.join("backend-runtime").join(".venv");
    let bundled_marker = bundled_runtime_marker(resource_root, &archive)?;
    let installed_marker = runtime_dir.join(".runtime-ready");
    if let Some(path) = venv_python(&runtime_venv) {
        let marker_matches = fs::read_to_string(&installed_marker)
            .map(|marker| marker == bundled_marker)
            .unwrap_or(false);
        if marker_matches {
            patch_windows_bundled_runtime(&runtime_dir)?;
            return Ok(Some(path));
        }
        fs::remove_dir_all(&runtime_dir).map_err(|err| {
            format!(
                "无法清理过期内置运行时目录 {}: {err}",
                runtime_dir.display()
            )
        })?;
    }

    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir)
            .map_err(|err| format!("无法清理旧内置运行时目录 {}: {err}", runtime_dir.display()))?;
    }
    fs::create_dir_all(&runtime_dir)
        .map_err(|err| format!("无法创建内置运行时目录 {}: {err}", runtime_dir.display()))?;

    let archive_file = File::open(&archive)
        .map_err(|err| format!("无法打开内置 Python runtime {}: {err}", archive.display()))?;
    let decoder = GzDecoder::new(archive_file);
    let mut tar = Archive::new(decoder);
    tar.unpack(&runtime_dir)
        .map_err(|err| format!("解压内置 Python runtime 失败: {err}"))?;

    patch_windows_bundled_runtime(&runtime_dir)?;
    fs::write(&installed_marker, bundled_marker).map_err(|err| {
        format!(
            "无法写入内置运行时标记 {}: {err}",
            installed_marker.display()
        )
    })?;

    venv_python(&runtime_venv)
        .map(Some)
        .ok_or_else(|| format!("内置 Python runtime 缺少 venv: {}", runtime_venv.display()))
}

fn bundled_runtime_marker(resource_root: &Path, archive: &Path) -> Result<String, String> {
    let marker = resource_root.join("desktop-runtime").join(".runtime-ready");
    if marker.is_file() {
        return fs::read_to_string(&marker)
            .map_err(|err| format!("无法读取内置运行时标记 {}: {err}", marker.display()));
    }
    let metadata = archive.metadata().map_err(|err| {
        format!(
            "无法读取内置 Python runtime 元数据 {}: {err}",
            archive.display()
        )
    })?;
    Ok(format!(
        "archive={}\nsize={}\n",
        archive
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("backend-runtime.tar.gz"),
        metadata.len()
    ))
}

#[cfg(target_os = "windows")]
fn patch_windows_bundled_runtime(runtime_dir: &Path) -> Result<(), String> {
    let cfg = runtime_dir
        .join("backend-runtime")
        .join(".venv")
        .join("pyvenv.cfg");
    let home = runtime_dir.join("python").join("cpython");
    if !cfg.is_file() || !home.join("python.exe").is_file() {
        return Ok(());
    }

    let home_value = home.to_string_lossy();
    let content = fs::read_to_string(&cfg)
        .map_err(|err| format!("读取 Windows pyvenv.cfg 失败 {}: {err}", cfg.display()))?;
    let mut replaced = false;
    let mut lines = Vec::new();
    for line in content.lines() {
        if line.starts_with("home = ") {
            lines.push(format!("home = {home_value}"));
            replaced = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !replaced {
        lines.push(format!("home = {home_value}"));
    }
    fs::write(&cfg, format!("{}\n", lines.join("\n")))
        .map_err(|err| format!("写入 Windows pyvenv.cfg 失败 {}: {err}", cfg.display()))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn patch_windows_bundled_runtime(_runtime_dir: &Path) -> Result<(), String> {
    Ok(())
}

fn venv_python(venv_dir: &Path) -> Option<PathBuf> {
    let unix_python = venv_dir.join("bin").join("python");
    if unix_python.is_file() {
        return Some(unix_python);
    }
    let windows_python = venv_dir.join("Scripts").join("python.exe");
    if windows_python.is_file() {
        return Some(windows_python);
    }
    None
}

fn prepare_runtime_venv(backend_dir: &Path, runtime_dir: &Path) -> Result<(), String> {
    let uv = locate_command("uv").ok_or_else(|| {
        "未找到 uv，无法自动准备后端 Python 3.12 运行时。请先运行 `npm run desktop:bootstrap` 或安装 uv。"
            .to_string()
    })?;
    fs::create_dir_all(runtime_dir)
        .map_err(|err| format!("无法创建后端运行时目录 {}: {err}", runtime_dir.display()))?;

    let venv_dir = runtime_dir.join(".venv");
    run_setup_command(
        Command::new(&uv)
            .arg("venv")
            .arg("--python")
            .arg("3.12")
            .arg(&venv_dir)
            .current_dir(runtime_dir),
        "创建后端 Python 3.12 venv",
    )?;

    let python = venv_python(&venv_dir)
        .ok_or_else(|| format!("uv venv 后未找到 Python: {}", venv_dir.display()))?;
    run_setup_command(
        Command::new(&uv)
            .arg("pip")
            .arg("install")
            .arg("--python")
            .arg(&python)
            .arg("--index-url")
            .arg("https://download.pytorch.org/whl/cpu")
            .arg("torch==2.5.1")
            .arg("torchaudio==2.5.1")
            .current_dir(runtime_dir),
        "安装 torch/torchaudio",
    )?;
    if cfg!(target_os = "windows") {
        run_setup_command(
            Command::new(&uv)
                .arg("pip")
                .arg("install")
                .arg("--python")
                .arg(&python)
                .arg("-r")
                .arg(backend_dir.join("requirements.txt"))
                .current_dir(runtime_dir),
            "安装后端依赖",
        )?;
        run_setup_command(
            Command::new(&uv)
                .arg("pip")
                .arg("install")
                .arg("--python")
                .arg(&python)
                .arg("static-ffmpeg==3.0")
                .current_dir(runtime_dir),
            "安装 static-ffmpeg",
        )?;
    } else {
        run_setup_command(
            Command::new(&uv)
                .arg("pip")
                .arg("install")
                .arg("--python")
                .arg(&python)
                .arg("-r")
                .arg(backend_dir.join("requirements-dev.txt"))
                .current_dir(runtime_dir),
            "安装后端依赖",
        )?;
    }
    Ok(())
}

fn run_setup_command(command: &mut Command, label: &str) -> Result<(), String> {
    let output = command
        .env("UV_SYSTEM_CERTS", "1")
        .output()
        .map_err(|err| format!("{label} 失败：{err}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "{label} 失败，退出码 {:?}\n{}\n{}",
        output.status.code(),
        stdout,
        stderr
    ))
}

fn locate_command(name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).map(|p| p.join(name)).collect())
        .unwrap_or_default();
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local").join("bin").join(name));
        candidates.push(home.join(".cargo").join("bin").join(name));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn dev_backend_dir() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(|root| root.join("backend"))
}
