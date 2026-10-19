import { beforeEach, expect, it, vi } from 'vitest'
import type * as DiskBaselineSignature from '../../../../shared/disk-baseline-signature'
import { createFakeEditorModel } from './editor-autosave-controller-test-fixture'
import {
  __clearEditorModelDiskBaselinesForTests,
  stampAppliedEditorContent
} from './editor-model-disk-baseline'

const signing = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../../../shared/disk-baseline-signature', async (importOriginal) => {
  const actual = await importOriginal<typeof DiskBaselineSignature>()
  return {
    ...actual,
    getWrittenContentDiskSignature: (content: string) => {
      signing.calls += 1
      return actual.getWrittenContentDiskSignature(content)
    }
  }
})

beforeEach(() => {
  __clearEditorModelDiskBaselinesForTests()
  signing.calls = 0
})

it('signs a file once, not again on every remount or tab switch', () => {
  const disk = 'x'.repeat(1_000_000)
  const source = { fileId: '/repo/big.ts', diskContent: disk, restoredDiskSignature: undefined }
  for (let mount = 0; mount < 5; mount += 1) {
    const model = createFakeEditorModel(disk)
    stampAppliedEditorContent(model, model.getValue(), source, 'mount')
  }

  expect(signing.calls).toBe(1)

  stampAppliedEditorContent(
    createFakeEditorModel('reloaded'),
    'reloaded',
    { ...source, diskContent: 'reloaded' },
    'sync'
  )
  expect(signing.calls).toBe(2)
})
