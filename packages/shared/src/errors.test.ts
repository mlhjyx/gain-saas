import { describe, expect, it } from 'vitest';
import { ENGINE_ERROR_COPY, copyForError } from './errors.js';

describe('copyForError', () => {
  it('已知码返回登记文案', () => {
    expect(copyForError('SUPPRESSED').title).toContain('禁联');
  });

  it('未知码返回可上报的 fallback,不抛错', () => {
    const copy = copyForError('SOME_FUTURE_CODE');
    expect(copy.title).toBeTruthy();
    expect(copy.next).toContain('运营');
  });

  it('PRD D6 的 409 阻断族全部有登记', () => {
    const blockers = [
      'SUPPRESSED',
      'INVALID_STATE',
      'SUPPRESSED_CONTACT_UNREACHABLE',
      'STORAGE_RIGHTS_NOT_GRANTED',
      'SANCTIONS_HOLD_UNRESOLVED',
      'CONFLICT',
    ];
    for (const code of blockers) expect(code in ENGINE_ERROR_COPY).toBe(true);
  });
});
