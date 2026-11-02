import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { registry } from './registry';
import { columnOf, gqlTypeOf, type EntityDefinition } from './define-entity';
import { VIEWS, VIEW_LABEL, type View } from './view';
import type { EntityMeta, ViewContract } from './types';

const SCHEMA_VERSION = 'v1';
const PKG_ROOT = path.resolve(__dirname, '..');
const GENERATED_TS = path.join(PKG_ROOT, 'src/generated/contract.generated.ts');
const SCHEMA_DIR = path.join(PKG_ROOT, 'schema');
const check = process.argv.includes('--check');

const doc = (text: string): string => {
  const trimmed = text.trim();
  // Nếu description tự kết thúc bằng `"` thì sẽ thành `""""` và phá SDL.
  if (trimmed.includes('"""') || trimmed.endsWith('"')) {
    throw new Error(`description không hợp lệ cho SDL: ${JSON.stringify(trimmed)}`);
  }
  return `"""${trimmed}"""`;
};

function fieldsForView(entity: EntityDefinition, view: View) {
  return entity.fieldNames
    .filter((name) => entity.fields[name]!.views.includes(view))
    .map((name) => {
      const field = entity.fields[name]!;
      return {
        name,
        column: columnOf(name, field),
        gqlType: gqlTypeOf(name, field),
        description: field.description,
      };
    });
}

function buildSdl(view: View): string {
  const out: string[] = [];
  const line = (...parts: string[]) => out.push(...parts);

  line(
    doc(
      `Hợp đồng đọc CMS · view ${view.toUpperCase()} · ${SCHEMA_VERSION}.\n\n` +
        'SINH TỰ ĐỘNG từ zod contract. Đừng sửa tay — chạy `pnpm generate`.',
    ),
  );
  line('');

  for (const entity of registry) {
    const fields = fieldsForView(entity, view);
    line(`type ${entity.typeName} {`);
    for (const field of fields) {
      line(`  ${doc(field.description)}`);
      line(`  ${field.name}: ${field.gqlType}`);
    }
    line('}');
    line('');
  }

  line('type PageInfo {');
  line('  endCursor: String');
  line('  hasNextPage: Boolean!');
  line('}');
  line('');
  line('enum ChangeType {');
  line('  CREATED');
  line('  UPDATED');
  line('  DELETED');
  line('}');
  line('');
  line('type SyncChange {');
  line(`  ${doc('Số thứ tự tăng dần, dùng làm cursor.')}`);
  line('  seq: Int!');
  line(`  ${doc('Loại entity (supplier, country, …).')}`);
  line('  entity: String!');
  line(`  ${doc('Khoá của entity.')}`);
  line('  id: ID!');
  line(`  ${doc('Version tại thời điểm thay đổi.')}`);
  line('  version: Int!');
  line(`  ${doc('created | updated | deleted — deleted là tombstone.')}`);
  line('  changeType: ChangeType!');
  line('}');
  line('');

  for (const entity of registry) {
    line(`type ${entity.typeName}Connection {`);
    line(`  nodes: [${entity.typeName}!]!`);
    line('  pageInfo: PageInfo!');
    line('}');
    line('');
  }

  line('type Query {');
  for (const entity of registry) {
    line(`  ${doc(`Kéo một ${entity.name} theo id. Trả null nếu đã bị xoá.`)}`);
    line(`  ${entity.name}(id: ID!): ${entity.typeName}`);
    line(`  ${doc(`Danh sách ${entity.name} đang sống, phân trang bằng cursor id.`)}`);
    line(`  ${entity.plural}(first: Int = 50, after: String): ${entity.typeName}Connection!`);
  }
  line(`  ${doc('Mọi thay đổi sau một seq, kể cả tombstone. Đường bù khi mất message.')}`);
  line('  changes(afterSeq: Int!, limit: Int = 200): [SyncChange!]!');
  line(`  ${doc('Seq cao nhất đã chắc chắn đọc được. Dùng làm mốc khi sync lần đầu.')}`);
  line('  headSeq: Int!');
  line('}');

  return `${out.join('\n')}\n`;
}

function buildContract(view: View): ViewContract {
  const entities: Record<string, EntityMeta> = {};
  const forbidden: Array<{ entity: string; field: string }> = [];

  for (const entity of registry) {
    const fields = fieldsForView(entity, view);
    entities[entity.name] = {
      name: entity.name,
      table: entity.table,
      typeName: entity.typeName,
      queryField: entity.name,
      listField: entity.plural,
      connectionType: `${entity.typeName}Connection`,
      fields,
      selection: fields.map((field) => field.name).join(' '),
    };

    for (const name of entity.fieldNames) {
      const field = entity.fields[name]!;
      if (field.neverFor?.includes(view) || !field.views.includes(view)) {
        forbidden.push({ entity: entity.name, field: name });
      }
    }
  }

  return { view, schemaVersion: SCHEMA_VERSION, sdl: buildSdl(view), entities, forbidden };
}

function renderGeneratedModule(contracts: ViewContract[]): string {
  const chunks: string[] = [];
  chunks.push('// SINH TỰ ĐỘNG — chạy `pnpm generate`. Đừng sửa tay.');
  chunks.push("import type { ViewContract } from '../types';");
  chunks.push('');
  chunks.push(`export const SCHEMA_VERSION = '${SCHEMA_VERSION}';`);
  chunks.push('');
  chunks.push("export const CHANGE_TYPES = ['CREATED', 'UPDATED', 'DELETED'] as const;");
  chunks.push('export type ChangeTypeName = (typeof CHANGE_TYPES)[number];');
  chunks.push('');

  for (const contract of contracts) {
    const sdl = contract.sdl.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    chunks.push(`const ${contract.view}Sdl = \`${sdl}\`;`);
    chunks.push('');
  }

  for (const contract of contracts) {
    const meta = { ...contract, sdl: undefined };
    chunks.push(`export const ${contract.view}: ViewContract = {`);
    chunks.push(`  view: '${contract.view}',`);
    chunks.push(`  schemaVersion: SCHEMA_VERSION,`);
    chunks.push(`  sdl: ${contract.view}Sdl,`);
    chunks.push(`  entities: ${JSON.stringify(meta.entities, null, 2).replace(/\n/g, '\n  ')},`);
    chunks.push(`  forbidden: ${JSON.stringify(contract.forbidden).replace(/,/g, ', ').replace(/\},\{/g, '}, {')},`);
    chunks.push('};');
    chunks.push('');
  }

  chunks.push(`export const contracts = { ${contracts.map((c) => c.view).join(', ')} } as const;`);
  chunks.push('');
  return chunks.join('\n');
}

function write(file: string, content: string): 'same' | 'changed' | 'created' {
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (previous === content) return 'same';
  if (!check) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return previous === null ? 'created' : 'changed';
}

const contracts = VIEWS.map(buildContract);
const outputs: Array<[string, string]> = [
  [GENERATED_TS, renderGeneratedModule(contracts)],
  ...contracts.map(
    (contract): [string, string] => [
      path.join(SCHEMA_DIR, `schema.${contract.view}.${SCHEMA_VERSION}.graphql`),
      contract.sdl,
    ],
  ),
];

let stale = 0;
for (const [file, content] of outputs) {
  const state = write(file, content);
  if (state !== 'same') {
    if (check) stale += 1;
    console.log(`${state === 'created' ? '+' : '~'} ${path.relative(PKG_ROOT, file)}`);
  }
}

for (const contract of contracts) {
  console.log(`\n${VIEW_LABEL[contract.view]}`);
  for (const entity of Object.values(contract.entities)) {
    console.log(`  ${entity.name.padEnd(10)} ${entity.fields.map((f) => f.name).join(', ')}`);
  }
  if (contract.forbidden.length > 0) {
    const blocked = contract.forbidden.slice(0, 6).map((f) => `${f.entity}.${f.field}`);
    const more = contract.forbidden.length > 6 ? ` +${contract.forbidden.length - 6}` : '';
    console.log(`  bị chặn: ${blocked.join(', ')}${more}`);
  }
}

if (check && stale > 0) {
  console.error(`\n✗ ${stale} file sinh ra bị lệch bản đã commit. Chạy: pnpm generate`);
  process.exit(1);
}

console.log(check ? '\n✓ generated khớp bản đã commit' : '\n✓ đã sinh schema');
