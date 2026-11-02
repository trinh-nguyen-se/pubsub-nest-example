import type { Pool, PoolClient } from 'pg';

export type ChangeType = 'created' | 'updated' | 'deleted';

/**
 * `advisory`: tuần tự hoá lúc ghi → thứ tự commit trùng thứ tự seq (đúng).
 * `none`: không bảo vệ gì, dùng cho bài lab để thấy dòng bị bỏ sót.
 *
 * Không có chế độ `txid` với cursor seq — xem docs/fence-investigation.md:
 * txid được cấp ở lần ghi đầu tiên của transaction, seq ở lần ghi outbox sau đó,
 * nên hai thứ tự có thể đảo; và dòng của transaction đang mở thì không nhìn thấy
 * để mà chặn, nên "chỉ trả dòng đã qua rào" vẫn để lọt dòng seq lớn hơn.
 */
export type FenceStrategy = 'advisory' | 'none';

/** Khoá advisory: một hằng số duy nhất cho toàn bộ sync_change. */
export const FENCE_LOCK_KEY = 4711001;

export type ChangeInput = {
  entity: string;
  entityId: string;
  version: number;
  changeType: ChangeType;
};

export type ChangeRow = {
  seq: number;
  entity: string;
  entityId: string;
  version: number;
  changeType: ChangeType;
};

/**
 * Ghi một dòng outbox **trong transaction đang mở** của thay đổi nghiệp vụ.
 *
 * Với `advisory`, khoá được lấy ngay trước câu insert và giữ tới lúc COMMIT.
 * Cửa sổ bị khoá rất ngắn (entity đã ghi xong trước đó), và nó bảo đảm:
 * transaction nào commit trước thì seq nhỏ hơn. Nhờ vậy consumer chỉ cần
 * `seq > cursor` là không bao giờ bỏ sót.
 *
 * `txid` vẫn được ghi lại để soi khi vận hành, không dùng làm rào.
 */
export async function recordChange(
  tx: PoolClient,
  change: ChangeInput,
  strategy: FenceStrategy,
): Promise<number> {
  if (strategy === 'advisory') {
    await tx.query('select pg_advisory_xact_lock($1)', [FENCE_LOCK_KEY]);
  }

  const { rows } = await tx.query<{ seq: string }>(
    `insert into sync_change (entity, entity_id, version, change_type, txid)
     values ($1, $2, $3, $4, pg_current_xact_id())
     returning seq`,
    [change.entity, change.entityId, change.version, change.changeType],
  );

  return Number(rows[0]!.seq);
}

type RawChange = {
  seq: string;
  entity: string;
  entity_id: string;
  version: number;
  change_type: ChangeType;
};

const toChangeRow = (row: RawChange): ChangeRow => ({
  seq: Number(row.seq),
  entity: row.entity,
  entityId: row.entity_id,
  version: row.version,
  changeType: row.change_type,
});

/**
 * Đọc các thay đổi sau cursor. Đây là đường chính, cũng là đường bù khi mất message.
 *
 * Ở chế độ `advisory`, thứ tự commit trùng thứ tự seq nên `seq > $1` là đủ.
 * Ở chế độ `none` câu SQL này vẫn vậy — và đó chính là lỗi mà bài lab phơi ra.
 */
export async function selectChanges(
  db: Pool | PoolClient,
  options: { afterSeq: number; limit: number; entities?: string[] },
): Promise<ChangeRow[]> {
  const { afterSeq, limit, entities } = options;
  const { rows } = await db.query<RawChange>(
    `select seq, entity, entity_id, version, change_type
       from sync_change
      where seq > $1
        ${entities ? 'and entity = any($3::text[])' : ''}
      order by seq asc
      limit $2`,
    entities ? [afterSeq, limit, entities] : [afterSeq, limit],
  );
  return rows.map(toChangeRow);
}

/**
 * Mốc để consumer bắt đầu đồng bộ liên tục sau lần full sync đầu tiên.
 * Với `advisory` chỉ cần seq lớn nhất đã commit.
 */
export async function selectHeadSeq(db: Pool | PoolClient): Promise<number> {
  const { rows } = await db.query<{ head: string | null }>(
    'select max(seq) as head from sync_change',
  );
  return Number(rows[0]?.head ?? 0);
}

/**
 * Publisher cũng đi qua cùng bất biến: dòng chỉ hiện ra sau khi transaction của
 * nó commit, nên không thể gửi message cho dữ liệu chưa tồn tại.
 */
export async function selectPending(
  db: Pool | PoolClient,
  options: { limit: number },
): Promise<ChangeRow[]> {
  const { rows } = await db.query<RawChange>(
    `select seq, entity, entity_id, version, change_type
       from sync_change
      where published_at is null
      order by seq asc
      limit $1`,
    [options.limit],
  );
  return rows.map(toChangeRow);
}
