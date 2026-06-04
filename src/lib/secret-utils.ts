const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|pwd|api[_-]?key|apikey|authorization|bearer|credential|private)/i;

export function inferIsSecret(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function maskSecret(value: string): string {
  if (!value) {
    return "";
  }

  if (value.length <= 6) {
    return "******";
  }

  return `${value.slice(0, 2)}${"*".repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}
