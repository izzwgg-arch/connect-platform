import test from 'node:test'
import assert from 'node:assert/strict'
import { QuickBooksApiError } from '../lib/services/quickbooks'

test('QuickBooksApiError parses ValidationFault code 610 references', () => {
  const err = new QuickBooksApiError({
    status: 400,
    intuitTid: 'abc-610',
    fallbackMessage: 'QuickBooks API error',
    payload: {
      Fault: {
        type: 'ValidationFault',
        Error: [
          {
            Message: 'Object Not Found',
            Detail: "Something you're trying to use has been made inactive.",
            code: '610',
            element: 'ItemRef',
          },
        ],
      },
    },
  })

  assert.equal(err.isValidationFault(), true)
  assert.equal(err.hasFaultCode('610'), true)
  assert.equal(err.faults[0]?.references[0]?.field, 'ItemRef')
  assert.match(err.message, /code=610/)
  assert.match(err.message, /intuit_tid: abc-610/)
})

test('QuickBooksApiError infers reference field from fault text', () => {
  const err = new QuickBooksApiError({
    status: 400,
    intuitTid: null,
    fallbackMessage: 'QuickBooks API error',
    payload: {
      Fault: {
        type: 'ValidationFault',
        Error: [
          {
            Message: 'Invalid reference',
            Detail: 'CustomerRef 123 is inactive',
            code: '610',
          },
        ],
      },
    },
  })

  assert.equal(err.faults[0]?.references[0]?.field, 'CustomerRef')
})
