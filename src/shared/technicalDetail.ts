/** The two presentation registers. They never change what is stored. */
export type TechnicalDetail = 'full' | 'simple';

/** Presentation starts calm; Full reveals the same retained record. */
export const DEFAULT_TECHNICAL_DETAIL: TechnicalDetail = 'simple';

export function isTechnicalDetail(value: unknown): value is TechnicalDetail {
  return value === 'full' || value === 'simple';
}
