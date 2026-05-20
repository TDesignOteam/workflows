import type { TPermissionType } from '../types'

function sampleSize<T>(values: T[], size: number): T[] {
  const arr = [...values]
  for (let index = arr.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    ;[arr[index], arr[randomIndex]] = [arr[randomIndex], arr[index]]
  }
  return arr.slice(0, size)
}

export function dealStringToArr(para?: string): string[] {
  const arr: string[] = []

  if (para) {
    const paraArr = para.split(',')
    paraArr.forEach((item) => {
      if (item.trim()) {
        arr.push(item.trim())
      }
    })
  }

  return arr
}

export function dealRandomAssignees(assignees: string, randomTo: string | undefined): string[] {
  let arr = dealStringToArr(assignees)

  if (randomTo && Number(randomTo) > 0 && Number(randomTo) < arr.length) {
    arr = sampleSize(arr, Number(randomTo))
  }

  return arr
}

export function matchKeyword(content = '', keywords: string[]): boolean {
  return keywords.some(item => content.toLowerCase().includes(item))
}

export function checkDuplicate(body: string | void): boolean {
  if (!body || !body.startsWith('Duplicate of')) {
    return false
  }

  const parts = body.split(' ')
  return parts[0] === 'Duplicate' && parts[1] === 'of'
}

export function getPreMonth(m: number): number {
  return m === 1 ? 12 : m - 1
}

export function replaceStr2Arr(str: string, replace: string, split: string): string[] {
  return str
    .replace(replace, '')
    .trim()
    .split(split)
    .reduce((result: string[], item) => (item ? [...result, item.trim()] : result), [])
}

export function checkPermission(required: TPermissionType, permission: TPermissionType): boolean {
  const permissions: TPermissionType[] = ['read', 'write', 'admin']
  const requiredIndex = permissions.indexOf(required)
  const permissionIndex = permissions.indexOf(permission)
  return requiredIndex <= permissionIndex
}
