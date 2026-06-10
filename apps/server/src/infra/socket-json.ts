import type { RawData } from "ws";

export function parseSocketJson(data: RawData): unknown {
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data.toString();
  return JSON.parse(text) as unknown;
}
