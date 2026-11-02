/** Hai consumer có hai hình dạng nhu cầu khác nhau, nên hợp đồng đọc tách làm hai view. */
export const VIEWS = ['b2b', 'b2c'] as const;

export type View = (typeof VIEWS)[number];

export const VIEW_LABEL: Record<View, string> = {
  b2b: 'B2B · kho inventory (rộng, nông)',
  b2c: 'B2C · storefront (hẹp, sâu)',
};
