const {
  log,
  cozyClient,
  updateOrCreate,
  BaseKonnector,
  categorize
} = require('cozy-konnector-libs')
const moment = require('moment')
const { getSwileData } = require('./swile')
const { getToken } = require('./auth')
const doctypes = require('cozy-doctypes')
const { Document, BankAccount, BankTransaction, BankingReconciliator } =
  doctypes

Document.registerClient(cozyClient)

const minilog = require('@cozy/minilog')
minilog.suggest.allow('cozy-client', 'info')

const reconciliator = new BankingReconciliator({ BankAccount, BankTransaction })

class SwileConnector extends BaseKonnector {
  async fetch(fields) {
    if (process.env.NODE_ENV !== 'standalone') {
      cozyClient.new.login()
    }

    if (this.browser) {
      await this.browser.close()
    }
    try {
      const token = await getToken(this, fields.login, fields.password)
      const [cards, ops] = await getSwileData(fields.login, token)

      log('info', 'Successfully fetched data')
      log('info', 'Parsing ...')

      const accounts = this.parseAccounts(cards)
      const operations = this.parseOps(ops)
      const categorizedTransactions = await categorize(operations)
      const { accounts: savedAccounts } = await reconciliator.save(
        accounts,
        categorizedTransactions
      )

      log('info', savedAccounts)

      const balances = await fetchBalances(savedAccounts)
      await saveBalances(balances)
    } catch (e) {
      log('error', e)
      log('error', e.stack)
    }
  }

  parseAccounts(cards) {
    return cards.map(card => {
      return {
        vendorId: card.id,
        number: card.id,
        currency: card.balance.currency.iso_3,
        institutionLabel: 'Swile',
        label: card.label,
        balance: card.balance.value,
        type: 'Checkings'
      }
    })
  }

  parseOps(ops) {
    return ops.map(op => {
      const transaction = op.transactions.filter(t => t.type === 'ORIGIN')[0]
      const wallet = transaction.wallet
      const date = new Date(op.date).toISOString()
      return {
        vendorId: transaction.id,
        vendorAccountId: wallet.uuid,
        amount: transaction.amount.value / 100,
        date: date,
        dateOperation: date,
        dateImport: new Date().toISOString(),
        currency: transaction.amount.currency.iso_3,
        label: op.name,
        originalBankLabel: op.name
      }
    })
  }
}

const fetchBalances = accounts => {
  const now = moment()
  const todayAsString = now.format('YYYY-MM-DD')
  const currentYear = now.year()

  return Promise.all(
    accounts.map(async account => {
      const history = await getBalanceHistory(currentYear, account._id)
      history.balances[todayAsString] = account.balance

      return history
    })
  )
}

const getBalanceHistory = async (year, accountId) => {
  const index = await cozyClient.data.defineIndex(
    'io.cozy.bank.balancehistories',
    ['year', 'relationships.account.data._id']
  )
  const options = {
    selector: { year, 'relationships.account.data._id': accountId },
    limit: 1
  }
  const [balance] = await cozyClient.data.query(index, options)

  if (balance) {
    log(
      'info',
      `Found a io.cozy.bank.balancehistories document for year ${year} and account ${accountId}`
    )
    return balance
  }

  log(
    'info',
    `io.cozy.bank.balancehistories document not found for year ${year} and account ${accountId}, creating a new one`
  )
  return getEmptyBalanceHistory(year, accountId)
}

const getEmptyBalanceHistory = (year, accountId) => {
  return {
    year,
    balances: {},
    metadata: {
      version: 1
    },
    relationships: {
      account: {
        data: {
          _id: accountId,
          _type: 'io.cozy.bank.accounts'
        }
      }
    }
  }
}

const saveBalances = balances => {
  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}

const connector = new SwileConnector({
  cheerio: false,
  json: false
})

connector.run()
