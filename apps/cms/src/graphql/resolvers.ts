import { contractByView, type View } from '@pubsub/contract';
import type { ChangesReader } from '../read/changes-reader';
import type { ViewReader } from '../read/view-reader';

type Args = Record<string, unknown>;
type Resolver = (root: unknown, args: Args, context: unknown) => unknown;

export type ResolverMap = {
  Query: Record<string, Resolver>;
};

/**
 * Resolver sinh từ contract, không viết tay từng entity.
 *
 * Field nào được trả về là do SDL quyết định; cột nào được đọc là do view quyết
 * định. Hai lớp độc lập, nên lọt cost sang B2C phải sai ở cả hai chỗ.
 */
export function buildResolvers(
  view: View,
  deps: { reader: ViewReader; changes: ChangesReader },
): ResolverMap {
  const contract = contractByView[view];
  const query: Record<string, Resolver> = {};

  for (const meta of Object.values(contract.entities)) {
    query[meta.queryField] = (_root, args) =>
      deps.reader.findOne(meta, String(args.id));

    query[meta.listField] = (_root, args) =>
      deps.reader.list(meta, {
        first: typeof args.first === 'number' ? args.first : 50,
        after: typeof args.after === 'string' && args.after.length > 0 ? args.after : null,
      });
  }

  // Chỉ trả thay đổi của entity thuộc view này: view khác không thấy tên entity
  // (kể cả id/version) mà mình không được phép đọc.
  const ownEntities = Object.keys(contract.entities);

  query.changes = (_root, args) =>
    deps.changes.read({
      afterSeq: Number(args.afterSeq ?? 0),
      limit: Number(args.limit ?? 200),
      entities: ownEntities,
    });

  query.headSeq = () => deps.changes.headSeq();

  return { Query: query };
}
