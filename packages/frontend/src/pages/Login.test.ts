import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { toaster } from '@gradido/frontend-core'
import {
  attrsOf,
  byTag,
  classesOf,
  deepRender,
  find,
  findAll,
  textOf,
} from '@gradido/frontend-core/testing'
import { stubIcons } from '@gradido/frontend-core/testing/icons'
import m from 'mithril'
import { LoginErrorCode } from '../client'

stubIcons()

const { Login } = await import('./Login')
type Login = InstanceType<typeof Login>

const draw = (page: Login) => deepRender(page.view())

const inputs = (page: Login) => findAll(draw(page), byTag('input'))
const submit = (page: Login) =>
  find(draw(page), (vnode) => attrsOf(vnode)['data-test'] === 'submit-login')
const submitWrapper = (page: Login) =>
  find(draw(page), (vnode) => typeof attrsOf(vnode).onmouseenter === 'function')

const fill = (page: Login) => {
  const fields = (page as unknown as { form: { fields: Record<string, { set(v: string): void }> } })
    .form.fields
  fields.email.set('einhorn@gradido.net')
  fields.password.set('secret')
}

/** Submits the filled form against a backend that refuses the login with `code`. */
const submitRefusedWith = async (page: Login, code: LoginErrorCode) => {
  spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ error: { code, message: code } }, { status: 401 }),
  )
  // The page redraws when the answer is in; there is no mounted app to redraw here.
  spyOn(m, 'redraw').mockReturnValue(undefined)
  fill(page)
  const onsubmit = attrsOf(find(draw(page), byTag('form'))).onsubmit as (
    event: Partial<Event>,
  ) => Promise<void>
  await onsubmit({ preventDefault: () => undefined })
}

afterEach(() => {
  mock.restore()
})

describe('Login', () => {
  test('opens with both fields neutral', () => {
    const page = new Login()
    for (const input of inputs(page)) {
      expect(classesOf(input)).not.toContain('is-invalid')
    }
  })

  // The handler cannot live on the button itself: a disabled button fires no mouse
  // events, and the button is disabled for exactly as long as the reveal is useful.
  test('reaching for the disabled submit button reveals every problem', () => {
    const page = new Login()
    expect(attrsOf(submit(page)).disabled).toBe(true)
    expect(find(draw(page), (v) => classesOf(v).includes('is-invalid'))).toBeUndefined()
    ;(attrsOf(submitWrapper(page)).onmouseenter as () => void)()
    expect(findAll(draw(page), (v) => classesOf(v).includes('is-invalid'))).toHaveLength(2)
  })

  test('the submit button turns from disabled styling to gradido once the form is valid', () => {
    const page = new Login()
    expect(classesOf(submit(page))).toContain('btn-gradido-disable')

    const fields = (
      page as unknown as { form: { fields: Record<string, { set(v: string): void }> } }
    ).form.fields
    fields.email.set('einhorn@gradido.net')
    fields.password.set('secret')

    expect(classesOf(submit(page))).toContain('btn-gradido')
    expect(attrsOf(submit(page)).disabled).toBe(false)
  })

  test('an account that is not activated yet gets the page message and the toast', async () => {
    const toast = spyOn(toaster, 'error').mockImplementation(() => undefined)
    const page = new Login()
    await submitRefusedWith(page, LoginErrorCode.EmailNotValidated)

    expect(textOf(draw(page))).toContain('Your account has not been activated yet.')
    expect(toast).toHaveBeenCalledWith(
      'Unfortunately we could not find an (activated) account to the given data.',
    )
  })

  // Legacy shows the "no (activated) account" toast here too, which contradicts the page:
  // the backend reports a missing password only for an activated account.
  test('an account without a password gets the page message and no toast', async () => {
    const toast = spyOn(toaster, 'error').mockImplementation(() => undefined)
    const page = new Login()
    await submitRefusedWith(page, LoginErrorCode.NoPasswordSet)

    expect(textOf(draw(page))).toContain('Your password has not been set yet.')
    expect(toast).not.toHaveBeenCalled()
  })
})
