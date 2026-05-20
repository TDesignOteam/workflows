export type TPermissionType = 'read' | 'write' | 'admin' | 'none'

export interface Context {
  eventName: string
  actor: string
  repo: {
    owner: string
    repo: string
  }
  payload: {
    action?: string
    issue?: {
      number?: number
    }
    comment?: {
      id: number
      body: string
      user: {
        login: string
      }
      created_at: string
      updated_at: string
    }
  }
}

export type TEmoji = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'

export type TLockReasons = 'off-topic' | 'too heated' | 'resolved' | 'spam' | undefined

export type TIssueState = 'open' | 'closed'

export type TUpdateMode = 'append' | 'replace'

export type TUserPermission = TPermissionType

export type TCloseReason = 'completed' | 'not_planned'

export interface TOutInfo {
  auth: string
  id?: number
  number?: number
  title?: string
  body?: string
  state?: TIssueState
  created: string
  updated: string
}

export type TOutList = TOutInfo[]

export type TAction
  = | 'add-assignees'
    | 'add-labels'
    | 'close-issue'
    | 'create-comment'
    | 'create-issue'
    | 'create-label'
    | 'delete-comment'
    | 'lock-issue'
    | 'open-issue'
    | 'remove-assignees'
    | 'remove-labels'
    | 'set-labels'
    | 'unlock-issue'
    | 'update-comment'
    | 'update-issue'
    | 'check-inactive'
    | 'check-issue'
    | 'close-issues'
    | 'find-comments'
    | 'find-issues'
    | 'get-issue'
    | 'lock-issues'
    | 'mark-assignees'
    | 'mark-duplicate'
    | 'toggle-labels'
    | 'welcome'
