import { describe, expect, it } from 'vitest'
import { checkPermission, dealStringToArr, replaceStr2Arr } from './index'

describe('issues-helper util', () => {
  it('splits comma separated strings', () => {
    expect(dealStringToArr('a, b, , c')).toEqual(['a', 'b', 'c'])
  })

  it('replaces prefix and splits assignee command body', () => {
    expect(replaceStr2Arr('/assign @1 @2 @3@a 3  @s @1_2 2', '/assign', '@')).toEqual([
      '1',
      '2',
      '3',
      'a 3',
      's',
      '1_2 2',
    ])
  })

  it('compares permissions by hierarchy', () => {
    expect(checkPermission('read', 'admin')).toBe(true)
    expect(checkPermission('write', 'read')).toBe(false)
    expect(checkPermission('admin', 'none')).toBe(false)
  })
})
