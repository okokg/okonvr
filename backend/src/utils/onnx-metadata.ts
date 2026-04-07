/**
 * Minimal ONNX protobuf metadata parser.
 *
 * Extracts metadata_props from ONNX ModelProto without external dependencies.
 * ONNX uses protobuf3 — we only decode the fields we need:
 *   - field 2: producer_name (string)
 *   - field 6: doc_string (string)
 *   - field 14: metadata_props (repeated StringStringEntryProto)
 *
 * Ultralytics YOLO models embed: description, author, task, names, imgsz, stride, etc.
 */

/** Read a protobuf varint from buffer at offset. Returns [value, newOffset]. */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 35) break; // safety
  }
  return [result, pos];
}

/** Parse a protobuf StringStringEntryProto sub-message → {key, value}. */
function parseStringEntry(buf: Buffer, start: number, end: number): { key: string; value: string } {
  let key = '';
  let value = '';
  let pos = start;
  while (pos < end) {
    const [tag, pos2] = readVarint(buf, pos);
    pos = pos2;
    const wireType = tag & 0x07;
    const fieldNum = tag >> 3;

    if (wireType === 2) {
      const [len, pos3] = readVarint(buf, pos);
      pos = pos3;
      const str = buf.toString('utf8', pos, pos + len);
      pos += len;
      if (fieldNum === 1) key = str;
      else if (fieldNum === 2) value = str;
    } else if (wireType === 0) {
      const [, pos3] = readVarint(buf, pos);
      pos = pos3;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return { key, value };
}

export interface OnnxMetadata {
  producer?: string;
  description?: string;
  props: Record<string, string>;
}

/**
 * Parse ONNX model metadata from a file buffer.
 * Only reads top-level fields — does NOT load the full graph/weights.
 */
export function parseOnnxMetadata(buf: Buffer): OnnxMetadata {
  const result: OnnxMetadata = { props: {} };
  let pos = 0;
  const end = Math.min(buf.length, 64 * 1024); // only scan first 64KB for metadata

  while (pos < end) {
    const [tag, pos2] = readVarint(buf, pos);
    pos = pos2;
    const wireType = tag & 0x07;
    const fieldNum = tag >> 3;

    if (wireType === 2) {
      const [len, pos3] = readVarint(buf, pos);
      pos = pos3;

      if (fieldNum === 2) {
        // producer_name
        result.producer = buf.toString('utf8', pos, pos + len);
      } else if (fieldNum === 6) {
        // doc_string
        result.description = buf.toString('utf8', pos, pos + len);
      } else if (fieldNum === 14) {
        // metadata_props — sub-message
        const entry = parseStringEntry(buf, pos, pos + len);
        if (entry.key) result.props[entry.key] = entry.value;
      }
      // Skip field content (including graph = field 7, which is huge)
      pos += len;
    } else if (wireType === 0) {
      const [, pos3] = readVarint(buf, pos);
      pos = pos3;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break; // unknown wire type
    }
  }

  return result;
}
