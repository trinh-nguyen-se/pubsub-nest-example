export type Supplier = {
  id: string;
  name: string;
  description: string | null;
  photos: string[];
  version: number;
};

export type MirrorRow = {
  entity: string;
  id: string;
  version: number;
  payload: Record<string, unknown>;
  syncedAt: string;
};

export type ConsumerState = {
  view: string;
  cursor: number;
  headSeq: number | null;
  messagesReceived: number;
  applied: number;
  skipped: number;
  deleted: number;
  droppedMessages: number;
  reconciles: number;
  bootstrapped: boolean;
  lastError: string | null;
  counts: Record<string, number>;
};

export type CmsState = {
  fence: string;
  unpublished: number;
  headSeq: number;
  publisher: { adapter: string; published: number; failures: number; lastError: string | null };
};

export type SyncEvent = {
  at: string;
  kind: string;
  entity: string | null;
  seq: number | null;
  detail: string | null;
};

async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch('/graphql/b2c/v1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  if (!body.data) throw new Error(`HTTP ${response.status}`);
  return body.data;
}

/**
 * Query do FE tự viết, đúng field mà view B2C được thấy.
 * Không có costRate, margin, allotment — schema không cho.
 */
export async function fetchSuppliers(): Promise<Supplier[]> {
  const data = await graphql<{ suppliers: { nodes: Supplier[] } }>(
    `query Storefront {
       suppliers(first: 50) {
         nodes { id name description photos version }
       }
     }`,
  );
  return data.suppliers.nodes;
}

export const fetchMirror = (): Promise<MirrorRow[]> =>
  fetch('/mirror/supplier').then((response) => response.json());

export const fetchConsumerState = (): Promise<ConsumerState> =>
  fetch('/mirror/state').then((response) => response.json());

export const fetchCmsState = (): Promise<CmsState> =>
  fetch('/admin/state').then((response) => response.json());

export const fetchEvents = (): Promise<SyncEvent[]> =>
  fetch('/mirror/events').then((response) => response.json());

export type NewSupplier = {
  name: string;
  description: string;
  photos: string;
  costRate: string;
  margin: string;
  allotment: number;
  taxCode: string;
};

export async function createSupplier(input: NewSupplier): Promise<Supplier> {
  const response = await fetch('/admin/suppliers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      photos: input.photos
        .split(',')
        .map((photo) => photo.trim())
        .filter(Boolean),
      taxCode: input.taxCode || null,
      costRate: input.costRate,
      margin: input.margin,
      allotment: input.allotment,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body as Supplier;
}

export const renameSupplier = (id: string, name: string): Promise<Response> =>
  fetch(`/admin/suppliers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });

export const deleteSupplier = (id: string): Promise<Response> =>
  fetch(`/admin/suppliers/${id}`, { method: 'DELETE' });

export const reconcileNow = (): Promise<Response> => fetch('/mirror/reconcile', { method: 'POST' });
