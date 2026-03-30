/**
 * Models list handler — /v1/models
 */

import type { ServerResponse } from 'http';
import { ModelRegistry } from '../domain/types.js';

export function handleModels(res: ServerResponse): void {
  const models = Object.keys(ModelRegistry).map(id => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'kiro-proxy',
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: models }));
}
