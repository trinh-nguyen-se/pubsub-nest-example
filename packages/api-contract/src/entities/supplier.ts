import { z } from 'zod';
import { defineEntity } from '../define-entity';

/**
 * Supplier là entity nặng nhất: B2B cần giá vốn và allotment để vận hành kho,
 * B2C chỉ cần phần bán được cho end-user. costRate/margin/allotment bị cấm
 * tường minh ở B2C — có test hợp đồng canh việc này.
 */
export const supplier = defineEntity({
  name: 'supplier',
  plural: 'suppliers',
  typeName: 'Supplier',
  table: 'supplier',
  idPrefix: 's_',
  fields: {
    id: {
      type: z.string(),
      gqlType: 'ID!',
      views: ['b2b', 'b2c'],
      description: 'Mã supplier, ổn định vĩnh viễn (ví dụ s_218).',
    },
    name: {
      type: z.string(),
      views: ['b2b', 'b2c'],
      description: 'Tên thương mại hiển thị cho khách.',
    },
    description: {
      type: z.string().nullable(),
      views: ['b2c'],
      description: 'Mô tả dài dùng cho trang chi tiết storefront.',
    },
    photos: {
      type: z.array(z.string()),
      views: ['b2c'],
      description: 'Danh sách URL ảnh đã publish, thứ tự đã chốt.',
    },
    taxCode: {
      type: z.string().nullable(),
      views: ['b2b'],
      description: 'Mã số thuế dùng cho đối soát và hợp đồng.',
      neverFor: ['b2c'],
    },
    costRate: {
      type: z.string(),
      views: ['b2b'],
      description: 'Giá vốn CMS (Money dạng string, không dùng float).',
      neverFor: ['b2c'],
    },
    margin: {
      type: z.string(),
      views: ['b2b'],
      description: 'Biên lợi nhuận áp cho supplier.',
      neverFor: ['b2c'],
    },
    allotment: {
      type: z.number().int(),
      views: ['b2b'],
      description: 'Số phòng/ghế CMS cam kết giữ cho B2B.',
      neverFor: ['b2c'],
    },
    version: {
      type: z.number().int(),
      views: ['b2b', 'b2c'],
      description: 'Tăng mỗi lần ghi. Consumer dùng để bỏ message cũ/trùng.',
    },
  },
});
