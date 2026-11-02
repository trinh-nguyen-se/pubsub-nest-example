import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'graphql';
import { contractByView, registry } from '../src/index';

const schemaDir = path.resolve(__dirname, '../schema');

describe('hợp đồng đọc sinh từ zod', () => {
  it('B2C không bao giờ thấy cost, margin, allotment, taxCode', () => {
    const sdl = contractByView.b2c.sdl;
    for (const field of ['costRate', 'margin', 'allotment', 'taxCode', 'taxNote']) {
      expect(sdl).not.toContain(field);
    }
  });

  it('B2B thấy đủ field vận hành nhưng không thấy nội dung storefront', () => {
    const sdl = contractByView.b2b.sdl;
    for (const field of ['costRate', 'margin', 'allotment', 'taxCode']) {
      expect(sdl).toContain(field);
    }
    expect(sdl).not.toContain('photos');
  });

  it('mọi field đều có nhãn view, description và id/version ở cả hai view', () => {
    for (const entity of registry) {
      for (const name of entity.fieldNames) {
        const field = entity.fields[name]!;
        expect(field.views.length, `${entity.name}.${name}`).toBeGreaterThan(0);
        expect(field.description.length, `${entity.name}.${name}`).toBeGreaterThan(0);
      }
      expect(entity.fields.id!.views).toEqual(expect.arrayContaining(['b2b', 'b2c']));
      expect(entity.fields.version!.views).toEqual(expect.arrayContaining(['b2b', 'b2c']));
    }
  });

  it('SDL sinh ra là GraphQL hợp lệ', () => {
    for (const view of ['b2b', 'b2c'] as const) {
      expect(() => parse(contractByView[view].sdl)).not.toThrow();
    }
  });

  it('SDL đã commit khớp bản sinh ra từ contract', () => {
    for (const view of ['b2b', 'b2c'] as const) {
      const committed = readFileSync(path.join(schemaDir, `schema.${view}.v1.graphql`), 'utf8');
      expect(committed).toBe(contractByView[view].sdl);
    }
  });

  it('selection set của consumer chỉ chứa field có trong view', () => {
    for (const view of ['b2b', 'b2c'] as const) {
      for (const meta of Object.values(contractByView[view].entities)) {
        const names = meta.selection.split(' ');
        expect(names).toContain('id');
        expect(names).toContain('version');
        expect(names).toHaveLength(meta.fields.length);
      }
    }
  });
});
