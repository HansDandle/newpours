// Shared utility functions for NewPours
export function isEmpty(val: any): boolean {
  return val == null || (Array.isArray(val) && val.length === 0) || (typeof val === 'string' && val.trim() === '');
}
