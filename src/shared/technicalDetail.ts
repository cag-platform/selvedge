/** The two presentation registers. They never change what is stored. */
export type TechnicalDetail = 'full' | 'simple';

export function isTechnicalDetail(value: unknown): value is TechnicalDetail {
  return value === 'full' || value === 'simple';
}
