# Đường lên AWS (làm khi final)

Phần lõi chỉ biết cổng `ChangePublisher`. Đổi hạ tầng = thêm adapter + cấu hình CI, không sửa
publisher worker, không sửa consumer, không sửa hợp đồng đọc.

## 1. SNS → SQS

Hiện tại: `RedisChangePublisher` phát vào `cms.sync.b2b` và `cms.sync.b2c`.

Trên AWS:

| Local | AWS |
| --- | --- |
| channel `cms.sync.b2b` | SNS topic `cms-sync` → SQS queue `cms-sync-b2b` |
| channel `cms.sync.b2c` | cùng topic → SQS queue `cms-sync-b2c` |
| subscriber Redis | consumer poll SQS (long polling) |

Việc cần làm:

1. `SnsChangePublisher` (đã có stub ở `apps/cms/src/sync/publishers.ts`): `PublishCommand` một lần cho
   topic; fan-out do SNS lo, publisher không cần biết có bao nhiêu consumer.
2. Queue policy: chỉ cho phép `sns.amazonaws.com` gửi, điều kiện `aws:SourceArn` = ARN topic.
3. DLQ cho mỗi queue, `maxReceiveCount` 5; alarm khi DLQ có message.
4. Mã hoá: SSE-KMS cho topic và queue; consumer cần quyền `kms:Decrypt`.
5. Consumer: thay `subscriber` Redis bằng SQS poller; giữ nguyên `SyncEngine.applyChange` và
   `reconcile`.

## 2. Giữ nguyên `changes()` dù đã có SQS

SQS bền hơn Redis nhưng vẫn có thể: message hết hạn retention, DLQ, consumer bị xoá rồi tạo lại với
cursor cũ. Nhịp `changes(afterSeq)` mỗi vài giây là thứ đảm bảo "cuối cùng vẫn đúng". Đừng bỏ.

## 3. CodeArtifact cho SDL

Hiện tại FE lấy `packages/api-contract/schema/schema.b2c.v1.graphql` từ repo.

Trên AWS:

1. CI publish package `@cms/contract` (kèm SDL + typings + contract meta) lên CodeArtifact sau mỗi
   lần `pnpm gate` xanh.
2. Repo FE B2C cài `@cms/contract@1.x`, chạy `graphql-codegen` trên SDL đó để sinh hook + type.
3. Version của package = version của schema. Phá vỡ tương thích → publish `schema.b2c.v2` chứ không
   sửa `v1`.

## 4. Khác region

- SNS ở region A gửi được sang SQS ở region B (cần policy đúng).
- GraphQL xuyên region có độ trễ thật: consumer nên kéo theo batch (nhiều id một lần) thay vì gọi
  lắt nhắt. Khi đó thêm query `suppliersByIds(ids: [ID!]!)` vào contract — vẫn sinh tự động.
- Đặt consumer cùng region với CMS nếu được; SQS/SNS chịu được khác region, nhưng round-trip GraphQL
  thì không miễn phí.

## 5. Vận hành

- Metrics CloudWatch: `ApproximateNumberOfMessagesVisible` (tồn đọng), `AgeOfOldestMessage` (lag),
  `publisher.unpublished` (outbox tắc), `changes()` latency.
- Alarm: outbox chưa gửi > 0 trong 2 phút; lag consumer > 5 phút.
- Retention `sync_change`: job xoá theo `CHANGE_RETENTION_DAYS`, nhưng phải lớn hơn lag tối đa cho
  phép của consumer, nếu không consumer tụt sẽ không bù được và phải full resync.
- Token máy-với-máy: chuyển sang Secrets Manager, xoay vòng; hoặc mTLS nếu hai bên cùng VPC.
- `GRAPHQL_INTROSPECTION=false` ở production; chặn depth/complexity/rate limit theo consumer.
