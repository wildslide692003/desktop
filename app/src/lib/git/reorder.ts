import * as FSE from 'fs-extra'
import { getCommits, revRange } from '.'
import { CommitOneLine } from '../../models/commit'
import { MultiCommitOperationKind } from '../../models/multi-commit-operation'
import { IMultiCommitOperationProgress } from '../../models/progress'
import { Repository } from '../../models/repository'
import { getTempFilePath } from '../file-system'
import { rebaseInteractive, RebaseResult } from './rebase'

/**
 * Squashes provided commits by calling interactive rebase.
 *
 * Goal is to replay the commits in order from oldest to newest to reduce
 * conflicts with toMove commits placed in the log at the location of the
 * squashOnto commit.
 *
 * Example: A user's history from oldest to newest is A, B, C, D, E and they
 * want to squash A and E (toMove) onto C. Our goal:  B, A-C-E, D. Thus,
 * maintaining that A came before C and E came after C, placed in history at the
 * the squashOnto of C.
 *
 * Also means if the last 2 commits in history are A, B, whether user squashes A
 * onto B or B onto A. It will always perform based on log history, thus, B onto
 * A.
 *
 * @param toMove - commits to move
 * @param afterCommit  - commits will be moved right before this commit. If it's
 * null, the commits will be moved to the end of the history.
 * @param lastRetainedCommitRef - sha of commit before commits in squash or null
 * if commit to be squash is the root (first in history) of the branch
 * @param commitMessage - the first line of the string provided will be the
 * summary and rest the body (similar to commit implementation)
 */
export async function reorder(
  repository: Repository,
  toMove: ReadonlyArray<CommitOneLine>,
  afterCommit: CommitOneLine | null,
  lastRetainedCommitRef: string | null,
  progressCallback?: (progress: IMultiCommitOperationProgress) => void
): Promise<RebaseResult> {
  let todoPath
  let result: RebaseResult

  try {
    if (toMove.length === 0) {
      throw new Error('[reorder] No commits provided to reorder.')
    }

    const toMoveShas = new Set(toMove.map(c => c.sha))

    const commits = await getCommits(
      repository,
      lastRetainedCommitRef === null
        ? undefined
        : revRange(lastRetainedCommitRef, 'HEAD')
    )

    if (commits.length === 0) {
      throw new Error(
        '[reorder] Could not find commits in log for last retained commit ref.'
      )
    }

    todoPath = await getTempFilePath('reorderTodo')
    let foundBaseCommitInLog = false
    const toReplayBeforeBaseCommit = []
    const toReplayAfterReorder = []

    // Traversed in reverse so we do oldest to newest (replay commits)
    for (let i = commits.length - 1; i >= 0; i--) {
      const commit = commits[i]
      if (toMoveShas.has(commit.sha)) {
        // If it is toMove commit and we have found the base commit, we
        // can go ahead and insert them (as we will hold any picks till after)
        if (foundBaseCommitInLog) {
          await FSE.appendFile(
            todoPath,
            `pick ${commit.sha} ${commit.summary}\n`
          )
        } else {
          // However, if we have not found the base commit yet we want to
          // keep track of them in the order of the log. Thus, we use a new
          // `toReplayBeforeBaseCommit` array and not trust that what was sent is in the
          // order of the log.
          toReplayBeforeBaseCommit.push(commit)
        }

        continue
      }

      // If it's the base commit, replay to the toMove in the order they
      // appeared on the log to reduce potential conflicts.
      if (afterCommit !== null && commit.sha === afterCommit.sha) {
        foundBaseCommitInLog = true
        toReplayBeforeBaseCommit.unshift(commit)

        for (let j = 0; j < toReplayBeforeBaseCommit.length; j++) {
          await FSE.appendFile(
            todoPath,
            `pick ${toReplayBeforeBaseCommit[j].sha} ${toReplayBeforeBaseCommit[j].summary}\n`
          )
        }

        continue
      }

      // We can't just replay a pick in case there is a commit from the toMove
      // commits further up in history that need to be moved. Thus, we will keep
      // track of these and replay after traversing the remainder of the log.
      if (foundBaseCommitInLog) {
        toReplayAfterReorder.push(commit)
        continue
      }

      // If it is not one toMove nor the squashOnto and have not found the
      // squashOnto commit, we simply record it is an unchanged pick (before the
      // squash)
      await FSE.appendFile(todoPath, `pick ${commit.sha} ${commit.summary}\n`)
    }

    if (toReplayAfterReorder.length > 0) {
      for (let i = 0; i < toReplayAfterReorder.length; i++) {
        await FSE.appendFile(
          todoPath,
          `pick ${toReplayAfterReorder[i].sha} ${toReplayAfterReorder[i].summary}\n`
        )
      }
    }

    if (afterCommit === null) {
      for (let i = 0; i < toReplayBeforeBaseCommit.length; i++) {
        await FSE.appendFile(
          todoPath,
          `pick ${toReplayBeforeBaseCommit[i].sha} ${toReplayBeforeBaseCommit[i].summary}\n`
        )
      }
    } else if (!foundBaseCommitInLog) {
      throw new Error(
        '[reorder] The commit to squash onto was not in the log. Continuing would result in dropping the commits in the toMove array.'
      )
    }

    console.log(await (await FSE.readFile(todoPath)).toString('utf-8'))

    result = await rebaseInteractive(
      repository,
      todoPath,
      lastRetainedCommitRef,
      MultiCommitOperationKind.Squash,
      undefined,
      progressCallback,
      commits
    )
  } catch (e) {
    log.error(e)
    return RebaseResult.Error
  } finally {
    if (todoPath !== undefined) {
      FSE.remove(todoPath)
    }
  }

  return result
}