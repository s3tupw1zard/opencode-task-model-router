// ---------------------------------------------------------------------------
// Pattern matching — OpenCode-compatible glob with * and ? wildcards
// ---------------------------------------------------------------------------

/**
 * Matches a value against a glob pattern with OpenCode-compatible wildcards.
 *
 * @param pattern - Glob pattern with `*` (any characters) and `?` (single character)
 * @param value - String value to match against
 * @returns true if value matches the pattern
 *
 * @example
 * matchGlob("github_get_*", "github_get_issue") // true
 * matchGlob("read?", "read1") // true
 * matchGlob("read?", "read12") // false
 */
export function matchGlob(pattern: string, value: string): boolean {
  if (!pattern || !value) {
    return false;
  }

  // Convert glob pattern to regex
  let regexStr = "^";
  for (const char of pattern) {
    switch (char) {
      case "*":
        regexStr += ".*";
        break;
      case "?":
        regexStr += ".";
        break;
      // Escape special regex characters
      case ".":
      case "+":
      case "^":
      case "$":
      case "(":
      case ")":
      case "[":
      case "]":
      case "{":
      case "}":
      case "|":
      case "\\":
        regexStr += "\\" + char;
        break;
      default:
        regexStr += char;
    }
  }
  regexStr += "$";

  const regex = new RegExp(regexStr, "i"); // case-insensitive
  return regex.test(value);
}
