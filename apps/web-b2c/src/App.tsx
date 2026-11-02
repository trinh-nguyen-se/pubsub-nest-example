import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createSupplier,
  deleteSupplier,
  fetchCmsState,
  fetchConsumerState,
  fetchEvents,
  fetchMirror,
  fetchSuppliers,
  reconcileNow,
  renameSupplier,
  type CmsState,
  type ConsumerState,
  type MirrorRow,
  type NewSupplier,
  type Supplier,
  type SyncEvent,
} from './api';

const POLL_MS = 1500;

const emptyForm: NewSupplier = {
  name: '',
  description: '',
  photos: '',
  costRate: '750000',
  margin: '10',
  allotment: 10,
  taxCode: '',
};

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString('vi-VN', { hour12: false });

export function App() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [mirror, setMirror] = useState<MirrorRow[]>([]);
  const [consumer, setConsumer] = useState<ConsumerState | null>(null);
  const [cms, setCms] = useState<CmsState | null>(null);
  const [events, setEvents] = useState<SyncEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<NewSupplier>(emptyForm);

  const refresh = useCallback(async () => {
    try {
      const [nextSuppliers, nextMirror, nextConsumer, nextCms, nextEvents] = await Promise.all([
        fetchSuppliers(),
        fetchMirror(),
        fetchConsumerState(),
        fetchCmsState(),
        fetchEvents(),
      ]);
      setSuppliers(nextSuppliers);
      setMirror(nextMirror);
      setConsumer(nextConsumer);
      setCms(nextCms);
      setEvents(nextEvents.slice(0, 8));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const mirrorById = useMemo(
    () => new Map(mirror.map((row) => [row.id, row])),
    [mirror],
  );

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">CMS smv-core · lab pub/sub</p>
          <h1>Một thay đổi đi qua CMS, message, consumer như thế nào</h1>
          <p className="lead">
            Cột trái đọc thẳng CMS qua GraphQL. Cột phải là bản sao trong DB riêng của consumer B2C,
            được cập nhật bằng message mỏng rồi kéo dữ liệu về. Lệch version giữa hai cột chính là
            khoảng thời gian đồng bộ đang chạy.
          </p>
        </div>
        <div className="chips">
          <Chip label="rào cursor" value={cms?.fence ?? '—'} />
          <Chip label="publisher" value={cms?.publisher.adapter ?? '—'} />
          <Chip label="outbox chưa gửi" value={String(cms?.unpublished ?? '—')} />
          <Chip label="headSeq" value={String(cms?.headSeq ?? '—')} />
          <Chip label="cursor B2C" value={String(consumer?.cursor ?? '—')} />
        </div>
      </header>

      {error && (
        <p className="error">
          {error} — kiểm tra <code>pnpm dev</code> đã chạy và <code>pnpm infra:up</code> đã bật.
        </p>
      )}

      <section className="grid">
        <article>
          <h2>
            CMS · view B2C <span className="hint">GraphQL /graphql/b2c/v1</span>
          </h2>
          <ul className="list">
            {suppliers.map((supplier) => {
              const copy = mirrorById.get(supplier.id);
              const state = !copy ? 'missing' : copy.version < supplier.version ? 'syncing' : 'equal';
              return (
                <li key={supplier.id}>
                  <div className="row">
                    <strong>{supplier.name}</strong>
                    <span className="badge">v{supplier.version}</span>
                    <Status state={state} />
                  </div>
                  <p className="muted">{supplier.description ?? 'không có mô tả'}</p>
                  <div className="row small">
                    <code>{supplier.id}</code>
                    <span>{supplier.photos.length} ảnh</span>
                    <button disabled={busy} onClick={() => void act(() => renameSupplier(supplier.id, `${supplier.name} *`))}>
                      đổi tên
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => void act(() => deleteSupplier(supplier.id))}
                    >
                      xoá
                    </button>
                  </div>
                </li>
              );
            })}
            {suppliers.length === 0 && <li className="muted">chưa có supplier nào — tạo ở form bên dưới</li>}
          </ul>
        </article>

        <article>
          <h2>
            Bản sao của consumer B2C <span className="hint">Postgres schema b2c</span>
          </h2>
          <div className="metrics">
            <Metric label="message nhận" value={consumer?.messagesReceived} />
            <Metric label="áp dụng" value={consumer?.applied} />
            <Metric label="bỏ qua" value={consumer?.skipped} />
            <Metric label="đã xoá" value={consumer?.deleted} />
            <Metric label="message bị bỏ" value={consumer?.droppedMessages} />
            <Metric label="lần quét changes" value={consumer?.reconciles} />
          </div>
          <ul className="list">
            {mirror.map((row) => (
              <li key={row.id}>
                <div className="row">
                  <strong>{String(row.payload.name ?? row.id)}</strong>
                  <span className="badge">v{row.version}</span>
                </div>
                <div className="row small">
                  <code>{row.id}</code>
                  <span>đồng bộ lúc {time(row.syncedAt)}</span>
                </div>
                <p className="muted small">
                  có: {Object.keys(row.payload).join(', ')}
                </p>
              </li>
            ))}
            {mirror.length === 0 && <li className="muted">consumer chưa có bản sao nào</li>}
          </ul>
          <button disabled={busy} onClick={() => void act(() => reconcileNow())}>
            quét changes() ngay
          </button>
        </article>
      </section>

      <section className="grid">
        <article>
          <h2>Tạo supplier ở CMS</h2>
          <p className="muted small">
            Form gửi cả costRate và margin. B2C sẽ không bao giờ thấy hai field đó: chúng bị chặn ở
            SDL và không được select khỏi DB cho view B2C.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await createSupplier(form);
                setForm(emptyForm);
              });
            }}
          >
            <label>
              Tên
              <input
                required
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label>
              Mô tả
              <textarea
                rows={2}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </label>
            <label>
              Ảnh (phẩy phân cách)
              <input
                value={form.photos}
                onChange={(event) => setForm({ ...form, photos: event.target.value })}
              />
            </label>
            <div className="row">
              <label>
                costRate
                <input
                  value={form.costRate}
                  onChange={(event) => setForm({ ...form, costRate: event.target.value })}
                />
              </label>
              <label>
                margin
                <input
                  value={form.margin}
                  onChange={(event) => setForm({ ...form, margin: event.target.value })}
                />
              </label>
              <label>
                allotment
                <input
                  type="number"
                  value={form.allotment}
                  onChange={(event) => setForm({ ...form, allotment: Number(event.target.value) })}
                />
              </label>
            </div>
            <button type="submit" disabled={busy}>
              tạo
            </button>
          </form>
        </article>

        <article>
          <h2>Nhật ký consumer</h2>
          <p className="muted small">
            Message đến thì ghi <code>message-applied</code>; message bị bỏ sẽ do{' '}
            <code>reconcile-*</code> xử lý.
          </p>
          <ul className="log">
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <span className="time">{time(event.at)}</span>
                <span className={`kind kind-${event.kind.split('-')[0]}`}>{event.kind}</span>
                <span className="muted small">
                  {event.entity ?? ''} {event.seq === null ? '' : `seq ${event.seq}`}
                </span>
              </li>
            ))}
            {events.length === 0 && <li className="muted">chưa có sự kiện</li>}
          </ul>
        </article>
      </section>

      <footer>
        Chạy <code>DROP_MESSAGES=1 pnpm dev</code> để thấy consumer vẫn đồng bộ đúng nhờ{' '}
        <code>changes(afterSeq)</code>.
      </footer>
    </main>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function Metric({ label, value }: { label: string; value?: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value ?? '—'}</strong>
    </div>
  );
}

function Status({ state }: { state: 'missing' | 'syncing' | 'equal' }) {
  const text = state === 'equal' ? 'khớp' : state === 'syncing' ? 'đang đồng bộ' : 'chưa có bản sao';
  return <span className={`status ${state}`}>{text}</span>;
}
