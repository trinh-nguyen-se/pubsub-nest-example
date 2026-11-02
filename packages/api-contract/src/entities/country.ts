import { z } from 'zod';
import { defineEntity } from '../define-entity';

export const country = defineEntity({
  name: 'country',
  plural: 'countries',
  typeName: 'Country',
  table: 'country',
  fields: {
    id: {
      type: z.string(),
      gqlType: 'ID!',
      views: ['b2b', 'b2c'],
      description: 'Mã quốc gia ISO 3166-1 alpha-2 (ví dụ VN).',
    },
    name: {
      type: z.string(),
      views: ['b2b', 'b2c'],
      description: 'Tên quốc gia hiển thị.',
    },
    description: {
      type: z.string().nullable(),
      views: ['b2c'],
      description: 'Đoạn giới thiệu ngắn cho trang storefront.',
    },
    taxNote: {
      type: z.string().nullable(),
      views: ['b2b'],
      description: 'Ghi chú thuế nội bộ dùng cho đối soát B2B.',
      neverFor: ['b2c'],
    },
    version: {
      type: z.number().int(),
      views: ['b2b', 'b2c'],
      description: 'Tăng mỗi lần ghi, dùng để lọc message trùng.',
    },
  },
});
