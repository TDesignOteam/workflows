import * as core from '@actions/core'

export function baseInfo(message: string) {
  core.info(message)
}

export function info(message: string) {
  core.info(`[issues-helper] ${message}`)
}

export function error(message: string) {
  core.error(`[issues-helper] ${message}`)
}

export function notice(message: string) {
  core.notice(`[issues-helper] ${message}`)
}

export function warning(message: string) {
  core.warning(`[issues-helper] ${message}`)
}

export const getInput = core.getInput
export const getBooleanInput = core.getBooleanInput
export const setOutput = core.setOutput

export function setFailed(message: string) {
  core.setFailed(`[issues-helper] ${message}`)
}
