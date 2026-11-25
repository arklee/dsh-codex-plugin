/** The initiating tab owns the sign-in conversation; closing it cancels the stream. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AuthorizationFlowView, AuthorizationFrame, AuthorizationPromptView } from '@arkli/dsh-model-oauth-authorization/types'
import type { ModelsOperations } from './operations.ts'
import type { ModelsKey } from './locales.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import styles from './ModelsSection.module.css'

type Translate = (key: ModelsKey) => string
type Notice = Extract<AuthorizationFrame, { kind: 'notice' }>['notice']
type Question = Extract<AuthorizationFrame, { kind: 'prompt' }>

/** A named key supersedes native auth; custom transports must not receive the provider's grant. */
export function oauthEligible(row: ProviderRow, profile: unknown): boolean {
  return row.entry.settingsNs === 'arkli-model-oauth-adapter' && row.entry.declared !== true && row.entry.error === undefined
    && row.entry.settingsPath.length === 2 && row.entry.settingsPath[0] === 'providers'
    && row.entry.settingsPath[1] === row.entry.provider && row.apiKeyEnv === undefined
    && (profile === undefined || (typeof profile === 'object' && profile !== null && !Array.isArray(profile)
      && !['apiKeyEnv', 'baseURL', 'api', 'headers'].some(field => Object.hasOwn(profile, field))))
}

function answerField(prompt: AuthorizationPromptView, value: string, change: (value: string) => void): ReactNode {
  return prompt.kind === 'select'
    ? <select className={`${styles['input']} ${styles['selectInput']}`} value={value} onChange={(event) => { change(event.target.value) }}>
      {prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    : <input className={styles['input']} type={prompt.kind === 'secret' ? 'password' : 'text'} autoComplete="off"
      placeholder={prompt.placeholder} value={value} onChange={(event) => { change(event.target.value) }} />
}

function Answer({ prompt, submit, t }: { prompt: AuthorizationPromptView; submit: (value: string) => void; t: Translate }): ReactNode {
  const [value, change] = useState(prompt.kind === 'select' ? prompt.options[0]?.id ?? '' : '')
  return <form className={styles['field']} onSubmit={(event) => { event.preventDefault(); submit(value) }}>
    <label className={styles['field']}><span className={styles['fieldLabel']}>{prompt.message}</span>
      {answerField(prompt, value, change)}
    </label>
    <div className={styles['editorActions']}><button className={styles['primaryButton']} type="submit">{t('welcomeContinue')}</button></div>
  </form>
}

/** Only the HTTPS verification page is navigable; the provider owns its one-time URL. */
function verificationUrl(value: string | undefined): string | undefined {
  if (value === undefined || !URL.canParse(value)) return undefined
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
}

/** Render the OAuth methods the Host actually registered, joined to native provider routes. */
export function OAuthProviderCard({ rows, excluded, controller, operations, schema, t, readOnly, onBusy, onClose, onSaved }: {
  rows: readonly ProviderRow[]
  excluded: readonly string[]
  controller: ModelsSettingsStore
  operations: ModelsOperations
  schema: SettingsSchemaOperations
  t: Translate
  readOnly: boolean
  onBusy: (busy: boolean) => void
  onClose: () => void
  onSaved: (row: ProviderRow) => void
}): ReactNode {
  const [flows, setFlows] = useState<readonly AuthorizationFlowView[]>()
  const [listRevision, reload] = useState(0)
  const [selected, select] = useState('')
  const [error, setError] = useState<string>()
  const [notices, setNotices] = useState<Notice[]>([])
  const [question, ask] = useState<Question>()
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [authorized, setAuthorized] = useState<string>()
  const lifetime = useRef<AbortController>()
  const stream = useRef<ReturnType<ModelsOperations['beginAuthorization']>>()

  useEffect(() => {
    let current = true
    const load = async (): Promise<void> => {
      const result = await operations.listAuthorization()
      if (!current) return
      if (result.ok) setFlows(result.value)
      else setError(t('oauthListFailed'))
    }
    void load().catch(() => { if (current) setError(t('oauthListFailed')) })
    return () => { current = false }
  }, [operations, listRevision, t])
  useEffect(() => () => { lifetime.current?.abort(); onBusy(false) }, [onBusy])

  const options = (flows ?? []).flatMap((flow) => {
    const row = rows.find(candidate => flow.key === `llm-pi-ai/${candidate.entry.provider}`)
    const method = flow.methods.find(candidate => candidate.id === 'oauth')
    return row === undefined || method === undefined ? [] : [{ row, flow, method }]
  })
  const current = options.find(candidate => candidate.row.entry.provider === selected) ?? options[0]
  const excludedNames = flows?.filter(flow => excluded.some(id => flow.key === `llm-pi-ai/${id}`)
    && flow.methods.some(method => method.id === 'oauth')).map(flow => flow.label) ?? []

  const run = async (): Promise<void> => {
    if (current === undefined || lifetime.current !== undefined) return
    const attempt = new AbortController()
    const abandoned = (): boolean => attempt.signal.aborted
    lifetime.current = attempt
    const { row, flow, method } = current
    setBusy(true); onBusy(true); setError(undefined); setNotices([])
    let granted = authorized === flow.key
    try {
      if (!granted) {
        const handle = operations.beginAuthorization(flow.key, method.id, attempt.signal)
        stream.current = handle
        for await (const frame of handle) {
          if (abandoned()) return
          if (frame.kind === 'done') {
            if (frame.status !== 'authorized') return
            granted = true
            break
          }
          if (frame.kind === 'notice') setNotices(previous => frame.notice.url !== undefined || frame.notice.code !== undefined
            ? [frame.notice] : [...previous.filter(notice => notice.url !== undefined || notice.code !== undefined), frame.notice])
          else if (frame.kind === 'prompt') ask(frame)
          else ask(previous => previous?.id === frame.id ? undefined : previous)
        }
        if (abandoned()) return
        if (!granted) { setError(t('oauthFailed')); return }
        setAuthorized(flow.key)
      }
      ask(undefined); setNotices([]); setSaving(true)
      // A credential push or another tab may have changed this route during login.
      await controller.load()
      if (abandoned()) return
      const snapshot = controller.store.getSnapshot()
      const latest = snapshot.rows.find(candidate => candidate.entry.provider === row.entry.provider)
      const ns = snapshot.namespaces.get(row.entry.settingsNs)
      if (snapshot.status !== 'ready' || !snapshot.writable || latest === undefined || ns === undefined
        || !oauthEligible(latest, schema.getPath(ns.value, latest.entry.settingsPath))) {
        setError(t('oauthSaveFailed')); return
      }
      if (!latest.configured) {
        const write = await operations.writeSettings(ns.ns, [{ op: 'set', path: [...latest.entry.settingsPath], value: {} }], ns.revision)
        if (abandoned()) return
        if (write.kind !== 'written') {
          setError(`${t('oauthSaveFailed')} ${write.kind === 'conflict' ? t('conflict') : write.message}`)
          return
        }
      }
      onSaved(latest)
    } catch {
      if (!abandoned()) setError(t(granted ? 'oauthSaveFailed' : 'oauthFailed'))
    } finally {
      stream.current = undefined
      lifetime.current = undefined
      if (!abandoned()) {
        ask(undefined); setNotices([]); setBusy(false); setSaving(false); onBusy(false)
      }
    }
  }
  return <>
    {flows === undefined && error === undefined ? <p role="status" className={styles['advancedHint']}>{t('oauthLoading')}</p> : null}
    {current === undefined ? flows === undefined ? null : <p className={styles['advancedHint']}>{t('oauthEmpty')}</p>
      : <label className={styles['field']}><span className={styles['fieldLabel']}>{t('provider')}</span>
        <select className={`${styles['input']} ${styles['selectInput']}`} value={current.row.entry.provider} disabled={busy}
          onChange={(event) => { select(event.target.value); setError(undefined) }}>
          {options.map(({ flow, row }) => <option key={flow.key} value={row.entry.provider}>{flow.label}</option>)}
        </select>
      </label>}
    {excludedNames.length === 0 ? null : <p className={styles['advancedHint']}>
      {t('oauthExcluded').replace('{providers}', () => excludedNames.join(', '))}
    </p>}
    {current?.flow.recordKind === 'grant' ? <p className={styles['savedNotice']}>{t('accountSignedIn')}</p> : null}
    {busy ? <div role="status" className={styles['field']}>
      {notices.length === 0 ? <span>{saving ? t('applying') : t('oauthSigningIn')}</span> : null}
      {notices.map((notice) => {
        const url = verificationUrl(notice.url)
        return <div key={notice.url ?? notice.code ?? notice.message} className={styles['field']}><span>{notice.message}</span>
          {notice.code === undefined ? null : <code>{notice.code}</code>}
          {url === undefined ? null : <a href={url} target="_blank" rel="noopener noreferrer">{t('oauthOpen')}</a>}
        </div>
      })}
    </div> : null}
    {question === undefined ? null : <Answer key={question.id} prompt={question.prompt} t={t} submit={(value) => {
      try { stream.current?.send({ id: question.id, value }); ask(undefined) }
      catch { stream.current?.dispose(); setError(t('oauthFailed')) }
    }} />}
    {error === undefined ? null : <p role="alert" className={styles['error']}>{error}</p>}
    <div className={styles['editorActions']}>
      <button type="button" className={styles['secondaryButton']} disabled={saving}
        onClick={() => { lifetime.current?.abort(); onClose() }}>{t('cancel')}</button>
      {(flows === undefined && error !== undefined) || current?.flow.inFlight === true ? <button type="button" className={styles['primaryButton']}
        onClick={() => { setError(undefined); reload(value => value + 1) }}>{t('retry')}</button> : null}
      {current === undefined || busy ? null : <button type="button" className={styles['primaryButton']}
        disabled={readOnly || current.flow.inFlight} onClick={() => { void run() }}>
        {authorized === current.flow.key ? t('apply') : t('oauthLogin')}
      </button>}
    </div>
  </>
}
