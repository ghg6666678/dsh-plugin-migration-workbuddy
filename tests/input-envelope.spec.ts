import { describe, expect, it } from 'vitest'
import { parseWorkBuddyInput } from '../src/input-envelope.js'

describe('WorkBuddy input envelope', () => {
  it('separates the human query and summarizes generated context', () => {
    const parsed = parseWorkBuddyInput([
      '<system-reminder data-role="user-context">',
      '<user_info>\nOS Version: darwin\nShell: /bin/bash\nWorkspace Folder: /tmp/demo\n</user_info>',
      '<identity_context>\n## SOUL.md\nPath: /Users/test/.workbuddy/SOUL.md\nsecret body must not be copied\n</identity_context>',
      '<manually_attached_skills>\nname: example-skill\n</manually_attached_skills>',
      '<user_query>请检查这个项目</user_query>',
      '</system-reminder>',
    ].join('\n'))
    expect(parsed.text).toBe('请检查这个项目')
    expect(parsed.hadContext).toBe(true)
    expect(parsed.hadQuery).toBe(true)
    expect(parsed.contextSections).toEqual(expect.arrayContaining([
      { name: '运行环境', text: expect.stringContaining('操作系统: darwin') },
      { name: '身份文件', text: '已加载 1 个身份文件: SOUL.md' },
      { name: '已挂载技能', text: '技能: example-skill' },
    ]))
    expect(JSON.stringify(parsed.contextSections)).not.toContain('secret body')
  })

  it('strips the additional-data preamble that opens every turn', () => {
    const parsed = parseWorkBuddyInput([
      '<system-reminder data-role="additional-data">',
      '<current_time>',
      'Wednesday, November 4, 2026 at 09:45:11 GMT+8',
      '</current_time>',
      '</system-reminder>',
      '',
      '请检查构建结果',
    ].join('\n'))
    expect(parsed.text).toBe('请检查构建结果')
    expect(parsed.text).not.toContain('system-reminder')
    expect(parsed.hadContext).toBe(true)
    expect(parsed.contextSections).toEqual(expect.arrayContaining([
      { name: '运行状态', text: expect.stringContaining('当前时间:') },
    ]))
  })

  it('keeps user-authored markup outside a generated envelope', () => {
    const parsed = parseWorkBuddyInput('请保留 <system-reminder> 这段文字')
    expect(parsed.text).toBe('请保留 <system-reminder> 这段文字')
    expect(parsed.hadContext).toBe(false)
  })

  it('retains malformed envelopes and reports a warning', () => {
    const parsed = parseWorkBuddyInput('<system-reminder data-role="user-context">\n<User query>broken')
    expect(parsed.text).toContain('<system-reminder')
    expect(parsed.warnings).toContain('unclosed system-reminder envelope; original content retained')
  })

  it('supports a query wrapper without the context wrapper', () => {
    expect(parseWorkBuddyInput('<user_query>hello</user_query>').text).toBe('hello')
  })

  it('folds a background task notification into the context row', () => {
    const parsed = parseWorkBuddyInput([
      '<task-notification>',
      '<task-id>lkTfSj</task-id>',
      '<status>completed</status>',
      '<summary>Background command "build" completed with exit code 0</summary>',
      '</task-notification>',
      '',
      'Use the TaskOutput tool with task_id="lkTfSj" to retrieve unread output if you need to act on it.',
      '[SYSTEM NOTIFICATION - NOT USER INPUT] This is an automated background-task event.',
    ].join('\n'))
    expect(parsed.text).toBe('')
    expect(parsed.hadContext).toBe(true)
    expect(parsed.contextSections).toEqual(expect.arrayContaining([
      { name: '后台任务', text: expect.stringContaining('lkTfSj') },
    ]))
  })

  it('folds a compaction summary into the context row', () => {
    const parsed = parseWorkBuddyInput([
      '<cb_summary>',
      'Summary of the conversation so far:',
      'The conversation is between an AI agent and a user.',
      '</cb_summary>',
    ].join('\n'))
    expect(parsed.text).toBe('')
    expect(parsed.contextSections).toEqual(expect.arrayContaining([
      { name: '历史压缩摘要', text: expect.stringContaining('Summary of the conversation') },
    ]))
  })

  it('keeps a quoted message as a section and the reply as the human text', () => {
    const parsed = parseWorkBuddyInput([
      '<message_quote type="text" source_message_id="m1">',
      '<original_text><![CDATA[被引用的原文]]></original_text>',
      '</message_quote>',
      '帮我把这个字体换掉',
    ].join('\n'))
    expect(parsed.text).toBe('帮我把这个字体换掉')
    expect(parsed.contextSections).toEqual(expect.arrayContaining([
      { name: '引用消息', text: '被引用的原文' },
    ]))
  })
})
