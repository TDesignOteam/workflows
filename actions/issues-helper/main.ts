import type { TAction } from './types'
import * as github from '@actions/github'
import { THANKS } from './const'
import * as core from './core'
import { IssueHelperEngine } from './helper'
import { dealStringToArr } from './util'

export async function main(): Promise<void> {
  const actions = core.getInput('actions', { required: true })
  const showThanks = core.getBooleanInput('show-thanks')
  const issueHelper = new IssueHelperEngine(github.context)

  for (const action of dealStringToArr(actions)) {
    await issueHelper.doExeAction(action as TAction)
  }

  if (showThanks) {
    core.baseInfo(`\n${THANKS}`)
  }
}
