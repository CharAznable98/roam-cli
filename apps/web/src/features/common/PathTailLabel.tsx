const MIN_TAIL_LENGTH = 18;
const MAX_TAIL_LENGTH = 28;

export function PathTailLabel({ value }: { value: string }) {
  const parts = splitPathTail(value);
  return (
    <span className="path-tail-label" title={value}>
      <span className="path-tail-label-head">{parts.head}</span>
      <span className="path-tail-label-tail">{parts.tail}</span>
    </span>
  );
}

function splitPathTail(value: string): { head: string; tail: string } {
  if (value.length <= MAX_TAIL_LENGTH) {
    return { head: value, tail: "" };
  }

  const fileName = value.split("/").pop() ?? value;
  const extensionStart = fileName.lastIndexOf(".");
  const extensionLength =
    extensionStart > 0 ? fileName.length - extensionStart : 0;
  const tailLength = Math.min(
    MAX_TAIL_LENGTH,
    Math.max(MIN_TAIL_LENGTH, extensionLength + 12),
    value.length,
  );

  return {
    head: value.slice(0, -tailLength),
    tail: value.slice(-tailLength),
  };
}
