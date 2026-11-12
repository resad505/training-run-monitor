import { describe, expect, it } from 'vitest'
import { setupCounter } from './counter.js'

describe('setupCounter', () => {
  it('initializes and increments the counter', () => {
    const element = {
      innerHTML: '',
      addEventListener: (_, handler) => {
        element.click = handler
      },
    }

    setupCounter(element)
    expect(element.innerHTML).toBe('Count is 0')

    element.click()
    expect(element.innerHTML).toBe('Count is 1')
  })
})
