import type {
  TCloseReason,
  TEmoji,
  TIssueState,
  TLockReasons,
  TPermissionType,
  TUpdateMode,
} from './default'

export interface IIssueBaseInfo {
  owner: string
  repo: string
  issueNumber?: number
  token: string
}

export interface IListIssuesParams {
  state: TIssueState | 'all'
  creator?: string
  assignee?: string
  mentioned?: string
  labels?: string
}

export interface TIssueInfo {
  number: number
  title: string | null
  body: string | null
  user: {
    login: string
  }
  assignees: {
    login: string
  }[]
  labels: {
    name: string
  }[]
  state: TIssueState
  created_at: string
  updated_at: string
  pull_request?: unknown
  locked?: boolean
}

export type TIssueList = TIssueInfo[]

export interface TCommentInfo {
  id: number
  body: string
  user: {
    login: string
  }
  created_at: string
  updated_at: string
}

export type TCommentList = TCommentInfo[]

export interface IIssueCoreEngine {
  setIssueNumber: (newIssueNumber: number) => void
  addAssignees: (assignees: string[]) => Promise<void>
  addLabels: (labels: string[]) => Promise<void>
  closeIssue: (reason: TCloseReason) => Promise<void>
  createComment: (body: string) => Promise<number>
  createCommentEmoji: (commentId: number, emoji: TEmoji[]) => Promise<void>
  createIssue: (
    title: string,
    body: string,
    labels?: string[],
    assignees?: string[],
  ) => Promise<number>
  createIssueEmoji: (emoji: TEmoji[]) => Promise<void>
  createLabel: (
    labelName: string,
    labelColor: string | undefined,
    labelDescription: string | undefined,
  ) => Promise<void>
  deleteComment: (commentId: number) => Promise<void>
  getIssue: () => Promise<TIssueInfo>
  getUserPermission: (username: string) => Promise<TPermissionType>
  listComments: () => Promise<TCommentList>
  listIssues: (params: IListIssuesParams) => Promise<TIssueList>
  lockIssue: (lockReason: TLockReasons) => Promise<void>
  openIssue: () => Promise<void>
  removeAssignees: (assignees: string[]) => Promise<void>
  removeLabels: (labels: string[]) => Promise<void>
  setLabels: (labels: string[]) => Promise<void>
  unlockIssue: () => Promise<void>
  updateComment: (commentId: number, body: string, mode: TUpdateMode) => Promise<void>
  updateIssue: (
    state: TIssueState,
    title: string | void,
    body: string | void,
    mode: TUpdateMode,
    labels?: string[] | void,
    assignees?: string[] | void,
  ) => Promise<void>
}
