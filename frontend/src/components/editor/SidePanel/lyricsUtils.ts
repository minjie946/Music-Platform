/** 在用户主题上追加引导语，让 LM 明确生成“有主唱歌词的歌曲”而非纯器乐。 */
export function buildVocalLyricsPrompt(topic: string): string {
  const t = topic.trim();
  return `请以「${t}」为主题，创作一首有主唱歌词的完整歌曲（不是纯器乐/instrumental）。要求每个段落（主歌/副歌等）都写出可演唱的中文歌词行，而不仅是段落结构标签。`;
}

/**
 * 判断歌词是否“空词”：去掉 [段落标签] 与空白后没有任何可唱内容。
 * 命中说明 LM 生成了纯器乐版（只有 [Intro]/[Verse]/[Chorus]… 结构）。
 */
export function isInstrumentalLyrics(lyrics: string | undefined | null): boolean {
  if (!lyrics) return true;
  const stripped = lyrics
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // 去掉 [xxx] 结构标签行
    .filter((line) => !/^\[.*\]$/.test(line));
  return stripped.length === 0;
}
