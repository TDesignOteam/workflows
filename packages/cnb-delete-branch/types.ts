export interface User {
  avatar: string
  email: string
  freeze: boolean
  is_npc: boolean
  nickname: string
  username: string
}

export interface Repo {
  id: string
  name: string
  path: string
  web_url: string
}

export interface PullRef {
  ref: string
  repo: Repo
  sha: string
}

export interface Label {
  color: string
  description: string
  id: string
  name: string
}

export interface PullRequest {
  assignees: User[]
  author: User
  base: PullRef
  blocked_on: string
  body: string
  comment_count: number
  created_at: string
  head: PullRef
  is_wip: boolean
  labels: Label[]
  last_acted_at: string
  mergeable_state: string
  merged_by: User
  number: string
  repo: Repo
  review_count: number
  state: string
  title: string
  updated_at: string
}
