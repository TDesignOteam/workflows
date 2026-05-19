export interface PullRequest {
  assignees: unknown[]
  author: unknown
  base: unknown
  blocked_on: string
  body: string
  comment_count: number
  created_at: string
  head: {
    ref: string
    repo: {
      id: string
      name: string
      path: string
      web_url: string
    } | null
    sha: string
  } | null
  is_wip: boolean
  labels: unknown[]
  last_acted_at: string
  mergeable_state: string
  merged_by: unknown
  number: string
  repo: unknown
  review_count: number
  state: string
  title: string
  updated_at: string
}
