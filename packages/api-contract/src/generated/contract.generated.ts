// SINH TỰ ĐỘNG — chạy `pnpm generate`. Đừng sửa tay.
import type { ViewContract } from '../types';

export const SCHEMA_VERSION = 'v1';

export const CHANGE_TYPES = ['CREATED', 'UPDATED', 'DELETED'] as const;
export type ChangeTypeName = (typeof CHANGE_TYPES)[number];

const b2bSdl = `"""Hợp đồng đọc CMS · view B2B · v1.

SINH TỰ ĐỘNG từ zod contract. Đừng sửa tay — chạy \`pnpm generate\`."""

type Supplier {
  """Mã supplier, ổn định vĩnh viễn (ví dụ s_218)."""
  id: ID!
  """Tên thương mại hiển thị cho khách."""
  name: String!
  """Mã số thuế dùng cho đối soát và hợp đồng."""
  taxCode: String
  """Giá vốn CMS (Money dạng string, không dùng float)."""
  costRate: String!
  """Biên lợi nhuận áp cho supplier."""
  margin: String!
  """Số phòng/ghế CMS cam kết giữ cho B2B."""
  allotment: Int!
  """Tăng mỗi lần ghi. Consumer dùng để bỏ message cũ/trùng."""
  version: Int!
}

type Country {
  """Mã quốc gia ISO 3166-1 alpha-2 (ví dụ VN)."""
  id: ID!
  """Tên quốc gia hiển thị."""
  name: String!
  """Ghi chú thuế nội bộ dùng cho đối soát B2B."""
  taxNote: String
  """Tăng mỗi lần ghi, dùng để lọc message trùng."""
  version: Int!
}

type PageInfo {
  endCursor: String
  hasNextPage: Boolean!
}

enum ChangeType {
  CREATED
  UPDATED
  DELETED
}

type SyncChange {
  """Số thứ tự tăng dần, dùng làm cursor."""
  seq: Int!
  """Loại entity (supplier, country, …)."""
  entity: String!
  """Khoá của entity."""
  id: ID!
  """Version tại thời điểm thay đổi."""
  version: Int!
  """created | updated | deleted — deleted là tombstone."""
  changeType: ChangeType!
}

type SupplierConnection {
  nodes: [Supplier!]!
  pageInfo: PageInfo!
}

type CountryConnection {
  nodes: [Country!]!
  pageInfo: PageInfo!
}

type Query {
  """Kéo một supplier theo id. Trả null nếu đã bị xoá."""
  supplier(id: ID!): Supplier
  """Danh sách supplier đang sống, phân trang bằng cursor id."""
  suppliers(first: Int = 50, after: String): SupplierConnection!
  """Kéo một country theo id. Trả null nếu đã bị xoá."""
  country(id: ID!): Country
  """Danh sách country đang sống, phân trang bằng cursor id."""
  countries(first: Int = 50, after: String): CountryConnection!
  """Mọi thay đổi sau một seq, kể cả tombstone. Đường bù khi mất message."""
  changes(afterSeq: Int!, limit: Int = 200): [SyncChange!]!
  """Seq cao nhất đã chắc chắn đọc được. Dùng làm mốc khi sync lần đầu."""
  headSeq: Int!
}
`;

const b2cSdl = `"""Hợp đồng đọc CMS · view B2C · v1.

SINH TỰ ĐỘNG từ zod contract. Đừng sửa tay — chạy \`pnpm generate\`."""

type Supplier {
  """Mã supplier, ổn định vĩnh viễn (ví dụ s_218)."""
  id: ID!
  """Tên thương mại hiển thị cho khách."""
  name: String!
  """Mô tả dài dùng cho trang chi tiết storefront."""
  description: String
  """Danh sách URL ảnh đã publish, thứ tự đã chốt."""
  photos: [String!]!
  """Tăng mỗi lần ghi. Consumer dùng để bỏ message cũ/trùng."""
  version: Int!
}

type Country {
  """Mã quốc gia ISO 3166-1 alpha-2 (ví dụ VN)."""
  id: ID!
  """Tên quốc gia hiển thị."""
  name: String!
  """Đoạn giới thiệu ngắn cho trang storefront."""
  description: String
  """Tăng mỗi lần ghi, dùng để lọc message trùng."""
  version: Int!
}

type PageInfo {
  endCursor: String
  hasNextPage: Boolean!
}

enum ChangeType {
  CREATED
  UPDATED
  DELETED
}

type SyncChange {
  """Số thứ tự tăng dần, dùng làm cursor."""
  seq: Int!
  """Loại entity (supplier, country, …)."""
  entity: String!
  """Khoá của entity."""
  id: ID!
  """Version tại thời điểm thay đổi."""
  version: Int!
  """created | updated | deleted — deleted là tombstone."""
  changeType: ChangeType!
}

type SupplierConnection {
  nodes: [Supplier!]!
  pageInfo: PageInfo!
}

type CountryConnection {
  nodes: [Country!]!
  pageInfo: PageInfo!
}

type Query {
  """Kéo một supplier theo id. Trả null nếu đã bị xoá."""
  supplier(id: ID!): Supplier
  """Danh sách supplier đang sống, phân trang bằng cursor id."""
  suppliers(first: Int = 50, after: String): SupplierConnection!
  """Kéo một country theo id. Trả null nếu đã bị xoá."""
  country(id: ID!): Country
  """Danh sách country đang sống, phân trang bằng cursor id."""
  countries(first: Int = 50, after: String): CountryConnection!
  """Mọi thay đổi sau một seq, kể cả tombstone. Đường bù khi mất message."""
  changes(afterSeq: Int!, limit: Int = 200): [SyncChange!]!
  """Seq cao nhất đã chắc chắn đọc được. Dùng làm mốc khi sync lần đầu."""
  headSeq: Int!
}
`;

export const b2b: ViewContract = {
  view: 'b2b',
  schemaVersion: SCHEMA_VERSION,
  sdl: b2bSdl,
  entities: {
    "supplier": {
      "name": "supplier",
      "table": "supplier",
      "typeName": "Supplier",
      "queryField": "supplier",
      "listField": "suppliers",
      "connectionType": "SupplierConnection",
      "fields": [
        {
          "name": "id",
          "column": "id",
          "gqlType": "ID!",
          "description": "Mã supplier, ổn định vĩnh viễn (ví dụ s_218)."
        },
        {
          "name": "name",
          "column": "name",
          "gqlType": "String!",
          "description": "Tên thương mại hiển thị cho khách."
        },
        {
          "name": "taxCode",
          "column": "tax_code",
          "gqlType": "String",
          "description": "Mã số thuế dùng cho đối soát và hợp đồng."
        },
        {
          "name": "costRate",
          "column": "cost_rate",
          "gqlType": "String!",
          "description": "Giá vốn CMS (Money dạng string, không dùng float)."
        },
        {
          "name": "margin",
          "column": "margin",
          "gqlType": "String!",
          "description": "Biên lợi nhuận áp cho supplier."
        },
        {
          "name": "allotment",
          "column": "allotment",
          "gqlType": "Int!",
          "description": "Số phòng/ghế CMS cam kết giữ cho B2B."
        },
        {
          "name": "version",
          "column": "version",
          "gqlType": "Int!",
          "description": "Tăng mỗi lần ghi. Consumer dùng để bỏ message cũ/trùng."
        }
      ],
      "selection": "id name taxCode costRate margin allotment version"
    },
    "country": {
      "name": "country",
      "table": "country",
      "typeName": "Country",
      "queryField": "country",
      "listField": "countries",
      "connectionType": "CountryConnection",
      "fields": [
        {
          "name": "id",
          "column": "id",
          "gqlType": "ID!",
          "description": "Mã quốc gia ISO 3166-1 alpha-2 (ví dụ VN)."
        },
        {
          "name": "name",
          "column": "name",
          "gqlType": "String!",
          "description": "Tên quốc gia hiển thị."
        },
        {
          "name": "taxNote",
          "column": "tax_note",
          "gqlType": "String",
          "description": "Ghi chú thuế nội bộ dùng cho đối soát B2B."
        },
        {
          "name": "version",
          "column": "version",
          "gqlType": "Int!",
          "description": "Tăng mỗi lần ghi, dùng để lọc message trùng."
        }
      ],
      "selection": "id name taxNote version"
    }
  },
  forbidden: [{"entity":"supplier", "field":"description"}, {"entity":"supplier", "field":"photos"}, {"entity":"country", "field":"description"}],
};

export const b2c: ViewContract = {
  view: 'b2c',
  schemaVersion: SCHEMA_VERSION,
  sdl: b2cSdl,
  entities: {
    "supplier": {
      "name": "supplier",
      "table": "supplier",
      "typeName": "Supplier",
      "queryField": "supplier",
      "listField": "suppliers",
      "connectionType": "SupplierConnection",
      "fields": [
        {
          "name": "id",
          "column": "id",
          "gqlType": "ID!",
          "description": "Mã supplier, ổn định vĩnh viễn (ví dụ s_218)."
        },
        {
          "name": "name",
          "column": "name",
          "gqlType": "String!",
          "description": "Tên thương mại hiển thị cho khách."
        },
        {
          "name": "description",
          "column": "description",
          "gqlType": "String",
          "description": "Mô tả dài dùng cho trang chi tiết storefront."
        },
        {
          "name": "photos",
          "column": "photos",
          "gqlType": "[String!]!",
          "description": "Danh sách URL ảnh đã publish, thứ tự đã chốt."
        },
        {
          "name": "version",
          "column": "version",
          "gqlType": "Int!",
          "description": "Tăng mỗi lần ghi. Consumer dùng để bỏ message cũ/trùng."
        }
      ],
      "selection": "id name description photos version"
    },
    "country": {
      "name": "country",
      "table": "country",
      "typeName": "Country",
      "queryField": "country",
      "listField": "countries",
      "connectionType": "CountryConnection",
      "fields": [
        {
          "name": "id",
          "column": "id",
          "gqlType": "ID!",
          "description": "Mã quốc gia ISO 3166-1 alpha-2 (ví dụ VN)."
        },
        {
          "name": "name",
          "column": "name",
          "gqlType": "String!",
          "description": "Tên quốc gia hiển thị."
        },
        {
          "name": "description",
          "column": "description",
          "gqlType": "String",
          "description": "Đoạn giới thiệu ngắn cho trang storefront."
        },
        {
          "name": "version",
          "column": "version",
          "gqlType": "Int!",
          "description": "Tăng mỗi lần ghi, dùng để lọc message trùng."
        }
      ],
      "selection": "id name description version"
    }
  },
  forbidden: [{"entity":"supplier", "field":"taxCode"}, {"entity":"supplier", "field":"costRate"}, {"entity":"supplier", "field":"margin"}, {"entity":"supplier", "field":"allotment"}, {"entity":"country", "field":"taxNote"}],
};

export const contracts = { b2b, b2c } as const;
