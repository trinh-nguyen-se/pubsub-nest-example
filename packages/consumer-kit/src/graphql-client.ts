import { contractByView, type EntityMeta, type View } from '@pubsub/contract';

export type ChangeTypeName = 'CREATED' | 'UPDATED' | 'DELETED';

export type Change = {
  seq: number;
  entity: string;
  id: string;
  version: number;
  changeType: ChangeTypeName;
};

export type PulledEntity = Record<string, unknown> & { id: string; version: number };

export type ChangesResponse = {
  changes: Change[];
  headSeq: number;
};

/**
 * Client GraphQL của consumer. Query được dựng từ contract đã sinh, không viết
 * tay: đổi field trong zod là query của consumer đổi theo.
 */
export class GraphqlClient {
  private readonly endpoint: string;

  constructor(
    baseUrl: string,
    private readonly view: View,
    private readonly token: string,
  ) {
    this.endpoint = `${baseUrl.replace(/\/$/, '')}/graphql/${view}/v1`;
  }

  async pull(meta: EntityMeta, id: string): Promise<PulledEntity | null> {
    const data = await this.query<Record<string, PulledEntity | null>>(
      `query Pull($id: ID!) { ${meta.queryField}(id: $id) { ${meta.selection} } }`,
      { id },
    );
    return data[meta.queryField] ?? null;
  }

  async list(
    meta: EntityMeta,
    options: { first: number; after?: string | null },
  ): Promise<{ nodes: PulledEntity[]; endCursor: string | null; hasNextPage: boolean }> {
    const data = await this.query<
      Record<string, { nodes: PulledEntity[]; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>
    >(
      `query List($first: Int, $after: String) {
         ${meta.listField}(first: $first, after: $after) {
           nodes { ${meta.selection} }
           pageInfo { endCursor hasNextPage }
         }
       }`,
      { first: options.first, after: options.after ?? null },
    );

    const connection = data[meta.listField]!;
    return {
      nodes: connection.nodes,
      endCursor: connection.pageInfo.endCursor,
      hasNextPage: connection.pageInfo.hasNextPage,
    };
  }

  async changes(afterSeq: number, limit: number): Promise<Change[]> {
    const data = await this.query<{ changes: Change[] }>(
      `query Changes($afterSeq: Int!, $limit: Int) {
         changes(afterSeq: $afterSeq, limit: $limit) { seq entity id version changeType }
       }`,
      { afterSeq, limit },
    );
    return data.changes;
  }

  async headSeq(): Promise<number> {
    const data = await this.query<{ headSeq: number }>('query { headSeq }');
    return data.headSeq;
  }

  entities(): EntityMeta[] {
    return Object.values(contractByView[this.view].entities);
  }

  private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    const body = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };

    if (body.errors && body.errors.length > 0) {
      const codes = body.errors.map((error) => error.extensions?.code ?? 'ERROR').join(', ');
      throw new Error(`GraphQL ${this.view} từ chối (${codes}): ${body.errors[0]!.message}`);
    }
    if (!response.ok || !body.data) {
      throw new Error(`GraphQL ${this.view} lỗi HTTP ${response.status}`);
    }
    return body.data;
  }
}
