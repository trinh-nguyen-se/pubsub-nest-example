# CMS GraphQL Sync · repo học cơ chế pub/sub

Dựng lại bằng code đúng luồng trong `context/CMS GraphQL Sync.md`: CMS ghi dữ liệu và ghi outbox
**cùng một transaction**, publisher gửi **message mỏng**, consumer kéo dữ liệu thật qua **GraphQL chỉ
đọc**, và `changes(afterSeq)` là đường bù khi message bị mất.

Mục đích của repo này là **hiểu cơ chế**, không phải khung dự án thật: mọi mắt xích then chốt đều
nằm trong file nhỏ, đọc được trong một lần, có test chứng minh.

Đã kiểm chứng trên máy này:

- `pnpm test` → 17/17 (rào cursor, tombstone ở cả hai phía, rollback, lọc theo view, hợp đồng)
- `pnpm lab` → in bảng so sánh `none` (mất dòng) với `advisory` (không mất)
- `pnpm e2e` → 18/18 trên hệ thống thật (CMS + 2 consumer + Redis + Postgres)
- `pnpm gate` → generated khớp bản commit, typecheck sạch, test xanh

## Kiến trúc

```
                      ┌──────────────────────── CMS :3001 ───────────────────────┐
  POST /admin/...     │  Portal/REST ──► EntityWriter                            │
  ────────────────────┼──►  BEGIN                                               │
                      │      update supplier (version + 1)                       │
                      │      insert sync_change(seq, txid)   ← cùng transaction  │
                      │    COMMIT                                                │
                      │                                                          │
                      │  PublisherWorker (250ms) ──► ChangePublisher ──► Redis   │
                      │      đọc WHERE published_at IS NULL (dòng đã commit)      │
                      │                                                          │
                      │  Apollo /graphql/b2b/v1   (token B2B)                    │
                      │  Apollo /graphql/b2c/v1   (token B2C)                    │
                      │      select đúng cột của view, không select *            │
                      └──────────────────────────────────────────────────────────┘
                            │ channel cms.sync.b2b            │ channel cms.sync.b2c
                            ▼                                 ▼
                  consumer-b2b :3002                 consumer-b2c :3003
                  message → lọc version → kéo GraphQL → upsert
                  mỗi 1.5s: changes(afterSeq) → bù message bị mất / tombstone
                  DB riêng: schema b2b               DB riêng: schema b2c

                  web-b2c :5173 (React 19 + Vite) đọc CMS qua proxy, hiển thị
                  cạnh bản sao của consumer để thấy độ lệch version
```

## Chạy

```bash
pnpm install
cp .env.example .env        # Postgres 45432, Redis 46379
pnpm infra:up               # docker compose: postgres:16 + redis:7
pnpm generate               # sinh SDL + contract từ zod (đã commit sẵn)
pnpm build
pnpm dev                    # CMS + consumer B2B + consumer B2C
pnpm dev --web              # thêm storefront React ở http://localhost:5173
```

Dữ liệu mẫu: `curl -X POST localhost:3001/admin/seed -H 'x-admin-token: admin-dev-token'`.

## Bản đồ mã nguồn

- `packages/api-contract/src/define-entity.ts` — khai báo field: zod type, nhãn view, mô tả. Field
  thiếu nhãn hoặc thiếu mô tả thì **không build được**.
- `packages/api-contract/src/entities/*.ts` — hai entity mẫu, `supplier` có cost/margin/allotment bị
  cấm ở B2C.
- `packages/api-contract/src/generate.ts` — sinh `schema/schema.{b2b,b2c}.v1.graphql` và
  `src/generated/contract.generated.ts` (SDL + field map + selection set). `--check` dùng cho gate.
- `apps/cms/src/sync/fence.ts` — **trái tim**: ghi outbox dưới khoá advisory (commit order = seq
  order), đọc `changes`/`headSeq`, đọc outbox cho publisher.
- `apps/cms/src/entities/entity-writer.ts` — entity + outbox trong cùng transaction; xoá mềm để có
  tombstone.
- `apps/cms/src/sync/sync.module.ts` — publisher worker + cổng `ChangePublisher`, adapter Redis và
  stub SNS.
- `apps/cms/src/read/view-reader.ts` — SQL chỉ select cột của view; cost không rời DB cho B2C.
- `apps/cms/src/graphql/` — hai Apollo server, hai SDL, token theo view, resolver sinh từ contract.
- `packages/consumer-kit/src/sync-engine.ts` — bootstrap, xử lý message, reconcile bằng `changes()`.
- `apps/consumer-b2b|b2c/src/main.ts` — cùng một khung, khác config (view, token, channel, schema).
- `apps/web-b2c/` — storefront React 19; proxy của Vite gắn token, browser không giữ token.

## Cơ chế, từng mắt xích

### 1. Outbox nằm trong cùng transaction

`EntityWriter` bọc `BEGIN … COMMIT`; bên trong vừa `update supplier` vừa `insert sync_change`.
Rollback thì dòng outbox biến mất theo, nên không có thông báo ma. Test:
`apps/cms/test/fence.test.ts` → "rollback thì dòng outbox biến mất theo".

### 2. Chống bỏ sót khi hai transaction commit chồng nhau

`seq` được cấp lúc ghi, không phải lúc commit, nên cursor `seq` trơn **mất dòng**: một transaction
commit muộn có thể để lại dòng nằm dưới cursor mà consumer đã nhảy qua.

Spec đề xuất thêm cột `txid` và chỉ trả dòng khi mọi transaction cũ hơn đã xong. Repo này **đã thử và
bỏ**: `txid` được cấp ở lần ghi đầu tiên (entity), `seq` ở lần ghi outbox sau đó, nên hai thứ tự đảo
nhau được; dòng đang mở thì không nhìn thấy để mà chặn. Phân tích đầy đủ + số liệu đo trong
`docs/fence-investigation.md`.

Cách đúng đang dùng: `FENCE_STRATEGY=advisory` — lấy `pg_advisory_xact_lock` ngay trước câu insert
outbox và giữ tới `COMMIT`. Thứ tự commit trùng thứ tự `seq`, nên reader chỉ cần `seq > cursor`.
Cửa sổ khoá rất ngắn vì entity đã ghi xong trước đó. `FENCE_STRATEGY=none` là chế độ cố tình sai
dùng cho bài lab.

`pnpm lab` in ra cả hai:

```
■ none      (không khoá — cursor seq trơn)
   seq cấp cho A/B   : 1 / 2
   B bị chặn         : không
   đọc khi A còn mở  : [2]
   cursor nhớ        : 2
   đọc lại sau commit: []
   dòng bị mất       : [1]  ← consumer không bao giờ thấy

■ advisory  (khoá advisory lúc ghi)
   seq cấp cho A/B   : 1 / 2
   B bị chặn         : có, ~153ms (đợi A commit)
   đọc khi A còn mở  : []
   cursor nhớ        : 2
   đọc lại sau commit: [1, 2]
   dòng bị mất       : không
```

### 3. Message mỏng, dữ liệu đi qua GraphQL

Message chỉ có `eventId, entity, id, version, changeType, seq`. E2E bắt một message thật trên
`cms.sync.b2b` và khẳng định đúng tập key đó, không có `name`/`costRate`.

### 4. Consumer xử lý ba bước, idempotent

1. **Lọc**: bản sao đã ở version này hoặc mới hơn thì bỏ qua.
2. **Kéo**: gọi `supplier(id)` trên endpoint của mình, query dựng từ selection set trong contract.
3. **Lưu**: upsert vào schema riêng; `deleted` thì xoá bản sao.

Message lặp, sai thứ tự hay đến muộn đều vô hại — đó là lý do publisher được phép at-least-once.

### 5. `changes(afterSeq)` là đường bù

Consumer quét `changes()` mỗi 1.5s và ghi cursor **sau khi** áp dụng xong từng dòng, nên lỗi giữa
đường thì lần sau làm lại. Chạy `DROP_MESSAGES=1 pnpm dev` để thấy consumer bỏ toàn bộ message mà
bản sao vẫn đúng: e2e có đúng kịch bản này.

### 6. Tombstone và retention

Xoá là xoá mềm, `version + 1`, ghi `deleted` — cách duy nhất để consumer biết phải xoá bản sao.
`sync_change` nên giữ ~30 ngày; ai tụt quá hạn thì full resync (bootstrap lại từ danh sách).

### 7. Bootstrap lần đầu

Chốt `headSeq` **trước** khi kéo danh sách, rồi đặt cursor = headSeq. Thay đổi xảy ra trong lúc kéo
vẫn được `changes()` nhặt lại. Xem `SyncEngine.bootstrap`.

## Hợp đồng sinh từ zod

`packages/api-contract` là nguồn duy nhất. Mỗi field khai báo zod type + view + mô tả; generator sinh
SDL cho từng view, field map và selection set. Thêm field mà quên gắn nhãn → TypeScript đỏ, generator
từ chối chạy. `pnpm gate` so bản sinh ra với bản đã commit; lệch là đỏ.

Hai SDL tách hẳn nhau, nên B2C không thể thấy field của B2B **kể cả qua introspection**, và reader
còn chỉ `select` đúng cột của view — hai lớp độc lập.

## Bảo mật đã kiểm bằng gì

- `B2C` hỏi `costRate` → `GRAPHQL_VALIDATION_FAILED` (field không tồn tại trong SDL).
- Token B2B gọi `/graphql/b2c/v1` → `403 FORBIDDEN`.
- Không token → `401 UNAUTHENTICATED`.
- Bản sao B2C không chứa `costRate`, `margin`, `allotment` (e2e kiểm trực tiếp trên payload).
- Schema không có `Mutation`, `introspection` tắt được bằng `GRAPHQL_INTROSPECTION=false`.

## Lab và kiểm thử

```bash
pnpm lab        # in bảng so sánh none/advisory (dùng schema `lab`, không đụng bảng thật)
pnpm test       # unit + tích hợp: rào cursor, tombstone, rollback, hợp đồng
pnpm e2e        # bật thật 3 service, kiểm 17 điểm đầu-cuối
pnpm gate       # check:generated + typecheck + test
```

`pnpm test` và `pnpm e2e` dùng chính DB dev: test truncate bảng CMS, e2e reset toàn bộ rồi seed lại.
Chạy chúng lúc không có `pnpm dev` để tránh consumer đang chạy giữa lúc bảng bị dọn.

## Khác spec ở đâu, vì sao

- **Không dùng `@nestjs/graphql`.** Schema ở đây sinh động từ zod và mỗi view một SDL; mount hai
  Apollo Server qua middleware của Nest (`@as-integrations/express5`) thẳng hơn là ép mô hình
  decorator code-first, và tránh đúng rủi ro "Apollo lệch phiên bản NestJS" mà spec đang mở. Nest
  vẫn giữ DI, controller, lifecycle, shutdown hook.
- **Không dùng rào `txid` cho cursor `seq`.** Lý do và phương án song song (cursor = `txid`) ở
  `docs/fence-investigation.md`. Đây là điểm khác spec lớn nhất, và là kết luận nên đưa vào plan.
- **Chưa dùng `graphql-codegen` ở FE.** FE tự viết query trên SDL đã commit; type do tay khai báo.
  Thêm codegen là việc của repo FE thật, không ảnh hưởng cơ chế sync.
- **Chưa có rate limit / depth / complexity.** Đây là tầng bảo vệ HTTP, cần làm trước khi ra internet.
- **Chưa có SNS/SQS.** `SnsChangePublisher` là stub báo lỗi rõ ràng; xem `docs/aws-later.md`.
- **Chưa có metrics Prometheus**, chỉ endpoint `/admin/state` và `/mirror/state`.

## Giới hạn đã biết

- `seq`/`headSeq` là GraphQL `Int` (32-bit) trong khi cột là `bigint`: vượt ~2,1 tỉ thay đổi thì phải
  đổi scalar. Với CMS, 2,1 tỉ thay đổi là rất xa, nhưng nên biết trước.
- Khoá advisory tuần tự hoá đường ghi outbox. Ổn với đường ghi của người dùng; nếu có batch import
  lớn, xem phương án cursor `txid` trong `docs/fence-investigation.md`.
- Consumer chưa có rate limit khi gọi `changes()`; `changes()` cũng chưa phân trang theo cursor phụ.
- CMS đang `enableCors()` mở cho mọi origin (tiện cho Vite dev). Production phải giới hạn origin.

## Việc cần làm trước khi dùng cho CMS thật

1. Rate limit + giới hạn depth/complexity + page size theo consumer (Apollo plugin).
2. Job xoá `sync_change` quá `CHANGE_RETENTION_DAYS`, kèm cảnh báo khi consumer tụt quá hạn.
3. Metrics: độ trễ publish, số dòng chưa gửi, query chậm, cursor lag từng consumer.
4. DLQ + replay khi lên SNS/SQS.
5. Danh sách entity thật + nhãn view từng field (chốt ở bước plan của dự án).
6. Chuyển xoá cứng hiện có sang xoá mềm trước khi bật sync.
7. mTLS hoặc xoay token định kỳ cho token máy-với-máy.

Xem thêm: `docs/fence-investigation.md` (vì sao không dùng rào txid), `docs/decisions.md` (các quyết
định khác) và `docs/aws-later.md` (đường lên AWS).
