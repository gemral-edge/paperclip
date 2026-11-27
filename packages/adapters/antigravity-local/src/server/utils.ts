const BENIGN_STDERR_PREAMBLE_RE =
    /^(?:warning:\s+conversation\s+["']?[^"'\r\n]+["']?\s+not found\b|root\s+agent\s+idle;\s+waiting\s+up\s+to\b|\[paperclip\]\s*(?:info|warn|warning)\s*:)/i;

export function firstNonEmptyLine(text: string): string {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) return "";
    // GEM-2194: a benign startup warning (e.g. `warning: conversation "<id>" not found`)
    // on stderr line 1 must not mask the real error line on line 2+.
    return lines.find((line) => !BENIGN_STDERR_PREAMBLE_RE.test(line)) ?? lines[0];
}
