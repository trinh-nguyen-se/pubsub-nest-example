import { randomUUID } from 'node:crypto';

export type ChangeTypeName = 'CREATED' | 'UPDATED' | 'DELETED';

/** Message mỏng: chỉ đủ để consumer biết "đến lấy bản nào". Không có dữ liệu nghiệp vụ. */
export type ChangeMessage = {
  eventId: string;
  entity: string;
  id: string;
  version: number;
  changeType: ChangeTypeName;
  seq: number;
};

export const toChangeTypeName = (changeType: 'created' | 'updated' | 'deleted'): ChangeTypeName =>
  changeType.toUpperCase() as ChangeTypeName;

export const makeMessage = (input: {
  entity: string;
  id: string;
  version: number;
  changeType: ChangeTypeName;
  seq: number;
}): ChangeMessage => ({ eventId: randomUUID(), ...input });

/**
 * Cổng duy nhất mà phần lõi biết. Đổi Redis → SNS chỉ là thêm một adapter,
 * không sửa publisher worker hay phần đọc.
 */
export interface ChangePublisher {
  publish(channels: string[], message: ChangeMessage): Promise<void>;
  readonly kind: string;
}

export const CHANGE_PUBLISHER = Symbol('CHANGE_PUBLISHER');
