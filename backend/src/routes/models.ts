import { FastifyInstance } from 'fastify';
import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import { createReadStream } from 'fs';
import { parseOnnxMetadata } from '../utils/onnx-metadata';

const MODELS_DIR = '/models';
const ALLOWED_EXT = new Set(['.onnx', '.tflite']);

// Cache parsed metadata (models don't change at runtime)
const metadataCache = new Map<string, Record<string, any>>();

async function getModelMeta(filePath: string): Promise<Record<string, any>> {
  if (metadataCache.has(filePath)) return metadataCache.get(filePath)!;
  try {
    // Read only first 64KB — metadata is in the header
    const fd = await readFile(filePath);
    const header = fd.subarray(0, Math.min(fd.length, 64 * 1024));
    const meta = parseOnnxMetadata(Buffer.from(header));
    const result: Record<string, any> = {};
    if (meta.description) result.description = meta.description;
    if (meta.producer) result.producer = meta.producer;
    // Ultralytics specific props
    if (meta.props.task) result.task = meta.props.task;
    if (meta.props.names) {
      try { result.names = JSON.parse(meta.props.names.replace(/'/g, '"')); }
      catch { result.names = meta.props.names; }
    }
    if (meta.props.imgsz) {
      try { result.imgsz = JSON.parse(meta.props.imgsz.replace(/'/g, '"')); }
      catch { result.imgsz = meta.props.imgsz; }
    }
    if (meta.props.stride) result.stride = meta.props.stride;
    if (meta.props.author) result.author = meta.props.author;
    if (meta.props.date) result.date = meta.props.date;
    if (meta.props.version) result.version = meta.props.version;
    metadataCache.set(filePath, result);
    return result;
  } catch {
    return {};
  }
}

export async function modelRoutes(fastify: FastifyInstance) {
  // GET /models — list available model files with metadata
  fastify.get('/models', async (_req, reply) => {
    try {
      const entries = await readdir(MODELS_DIR).catch(() => []);
      const models: Array<{
        name: string; size: number; sizeHuman: string;
        meta: Record<string, any>;
      }> = [];

      for (const name of entries) {
        const ext = name.substring(name.lastIndexOf('.'));
        if (!ALLOWED_EXT.has(ext)) continue;
        try {
          const filePath = join(MODELS_DIR, name);
          const info = await stat(filePath);
          if (!info.isFile()) continue;
          const sizeMB = info.size / 1e6;
          const meta = ext === '.onnx' ? await getModelMeta(filePath) : {};
          models.push({
            name,
            size: info.size,
            sizeHuman: sizeMB >= 1 ? `${sizeMB.toFixed(1)}MB` : `${(info.size / 1e3).toFixed(0)}KB`,
            meta,
          });
        } catch { /* skip */ }
      }

      models.sort((a, b) => a.name.localeCompare(b.name));

      return reply.send({
        models,
        builtin: { name: 'EfficientDet-Lite2 (CDN)', engine: 'mediapipe' },
      });
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /models/:filename — serve model file with streaming
  fastify.get('/models/:filename', async (req, reply) => {
    const { filename } = req.params as { filename: string };

    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return reply.code(400).send({ error: 'invalid filename' });
    }

    const ext = filename.substring(filename.lastIndexOf('.'));
    if (!ALLOWED_EXT.has(ext)) {
      return reply.code(400).send({ error: 'unsupported file type' });
    }

    const filePath = join(MODELS_DIR, filename);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return reply.code(404).send({ error: 'not found' });

      const stream = createReadStream(filePath);
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Length', info.size)
        .header('Cache-Control', 'public, max-age=604800')
        .header('Content-Disposition', `inline; filename="${filename}"`)
        .send(stream);
    } catch {
      return reply.code(404).send({ error: 'model not found' });
    }
  });
}
