import type { TimelineNote } from './timeline'

import { describe, expect, it } from 'vitest'

import { addTimelineNotes, applyTimelineSummary, EMPTY_TIMELINE, setTimelineScene, TIMELINE_LIMITS, timelineMarkerFrom, timelineNotesToSummarize, timelineSummaryRequest } from './timeline'

const HOUR = 60 * 60_000

function notes(count: number, start = 0): TimelineNote[] {
  return Array.from({ length: count }, (_, index) => ({ at: start + index * 1_000, text: `note ${index}`, source: 'model' as const }))
}

describe('timeline markers', () => {
  it('reads notes and scenes, flattens spaces, and cuts long texts', () => {
    expect(timelineMarkerFrom('<|NOTE  the boss   fight started |>')).toEqual({ kind: 'note', text: 'the boss fight started' })
    expect(timelineMarkerFrom('<|SCENE ranked match|>')).toEqual({ kind: 'scene', text: 'ranked match' })
    expect(timelineMarkerFrom(`<|NOTE ${'a'.repeat(200)}|>`)?.text).toHaveLength(TIMELINE_LIMITS.maxNoteLength)
    expect(timelineMarkerFrom('<|NOTE   |>')).toBeUndefined()
    expect(timelineMarkerFrom('<|TOPIC games|>')).toBeUndefined()
  })
})

describe('timeline', () => {
  it('adds notes in time order and drops empty ones', () => {
    const timeline = addTimelineNotes(addTimelineNotes(EMPTY_TIMELINE, [{ at: 20, text: 'later', source: 'model' }]), [
      { at: 10, text: 'earlier', source: 'code' },
      { at: 30, text: '   ', source: 'model' },
    ])

    expect(timeline.notes.map(note => note.text)).toEqual(['earlier', 'later'])
  })

  it('replaces the scene', () => {
    const timeline = setTimelineScene(setTimelineScene(EMPTY_TIMELINE, 'lobby', 1), 'ranked match', 2)

    expect(timeline.scene).toEqual({ text: 'ranked match', at: 2 })
  })

  it('summarizes the oldest notes past the count, and every note past the age', () => {
    expect(timelineNotesToSummarize({ notes: notes(TIMELINE_LIMITS.maxNotes) }, 0)).toBeUndefined()
    expect(timelineNotesToSummarize({ notes: notes(TIMELINE_LIMITS.maxNotes + 1) }, 0)).toHaveLength(TIMELINE_LIMITS.summarizeCount)

    const old = [...notes(3, 0), ...notes(2, 13 * HOUR)]
    expect(timelineNotesToSummarize({ notes: old }, 13 * HOUR + 5_000)?.map(note => note.at)).toEqual([0, 1_000, 2_000])
  })

  it('puts the summary in place of the notes it covers', () => {
    const timeline = applyTimelineSummary({ notes: notes(4), scene: { text: 'game', at: 0 } }, 'played a match', 1_000)

    expect(timeline).toEqual({ notes: notes(4).slice(2), scene: { text: 'game', at: 0 }, summary: { text: 'played a match', until: 1_000 } })
  })

  it('asks for a summary of the earlier summary and the notes', () => {
    const request = timelineSummaryRequest({ notes: [], summary: { text: 'played chess', until: 0 } }, notes(1))

    expect(JSON.stringify(request)).toContain('Earlier summary:\\nplayed chess')
    expect(JSON.stringify(request)).toContain('note 0')
  })
})
