'use strict'

const debug = require('./debug')
const Command = require('./command')

function onConnect (client) {
  debug('Stream connected %s id %s', client.address, client.connectionId)

  client.connected = true
  client.ready = false
  client.emittedEnd = false
  client._stream.setKeepAlive(client.options.socketKeepalive)
  client._stream.setTimeout(0)

  client.emit('connect')
  client.initializeRetryVars()

  if (client.options.noReadyCheck) {
    onReady(client)
  } else {
    readyCheck(client)
  }
}

function onReady (client) {
  debug('onReady called %s id %s', client.address, client.connectionId)
  client.ready = true

  client.cork = () => {
    client.pipeline = true
    client._stream.cork()
  }
  client.uncork = () => {
    if (client.fireStrings) {
      client.writeStrings()
    } else {
      client.writeBuffers()
    }
    client.pipeline = false
    client.fireStrings = true
    // TODO: Consider using next tick here. See https://github.com/NodeRedis/nodeRedis/issues/1033
    client._stream.uncork()
  }

  // Restore modal commands from previous connection. The order of the commands is important
  if (client.selectedDb !== undefined) {
    client.internalSendCommand(new Command('select', [client.selectedDb])).catch((err) => {
      if (!client.closing) {
        // TODO: These internal things should be wrapped in a
        // special error that describes what is happening
        process.nextTick(() => client.emit('error', err))
      }
    })
  }
  if (client.monitoring) { // Monitor has to be fired before pub sub commands
    client.internalSendCommand(new Command('monitor', [])).catch((err) => {
      if (!client.closing) {
        process.nextTick(() => client.emit('error', err))
      }
    })
  }
  const callbackCount = Object.keys(client.subscriptionSet).length
  // TODO: Replace the disableResubscribing by a individual function that may be called
  // Add HOOKS!!!
  // Replace the disableResubscribing by:
  // resubmit: {
  //   select: true,
  //   monitor: true,
  //   subscriptions: true,
  //   // individual: function noop () {}
  // }
  if (!client.options.disableResubscribing && callbackCount) {
    debug('Sending pub/sub onReady commands')
    for (const key in client.subscriptionSet) {
      const command = key.slice(0, key.indexOf('_'))
      const args = client.subscriptionSet[key]
      client[command]([args]).catch((err) => {
        if (!client.closing) {
          process.nextTick(() => client.emit('error', err))
        }
      })
    }
  }
  client.sendOfflineQueue()
  client.emit('ready')
}

function onInfoFail (client, err) {
  if (client.closing) {
    return
  }

  if (err.message === "ERR unknown command 'info'") {
    onReady(client)
    return
  }
  err.message = `Ready check failed: ${err.message}`
  client.emit('error', err)
  return
}

function onInfoCmd (client, res) {
  /* istanbul ignore if: some servers might not respond with any info data. client is just a safety check that is difficult to test */
  if (!res) {
    debug('The info command returned without any data.')
    onReady(client)
    return
  }

  if (!client.serverInfo.loading || client.serverInfo.loading === '0') {
    // If the master_link_status exists but the link is not up, try again after 50 ms
    if (client.serverInfo.master_link_status && client.serverInfo.master_link_status !== 'up') {
      client.serverInfo.loading_eta_seconds = 0.05
    } else {
      // Eta loading should change
      debug('Redis server ready.')
      onReady(client)
      return
    }
  }

  var retryTime = +client.serverInfo.loading_eta_seconds * 1000
  if (retryTime > 1000) {
    retryTime = 1000
  }
  debug('Redis server still loading, trying again in %s', retryTime)
  setTimeout((client) => readyCheck(client), retryTime, client)
}

function readyCheck (client) {
  debug('Checking server ready state...')
  // Always fire client info command as first command even if other commands are already queued up
  client.ready = true
  client.info()
    .then((res) => onInfoCmd(client, res))
    .catch((err) => onInfoFail(client, err))
  client.ready = false
}

module.exports = onConnect