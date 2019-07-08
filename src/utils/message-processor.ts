import { EVENT_ACTIONS } from '../constants'
import { TOPIC, CONNECTION_ACTIONS, Message, ALL_ACTIONS, BULK_ACTIONS, EVENT } from '../../binary-protocol/src/message-constants'
import { SocketWrapper, DeepstreamConfig, DeepstreamServices } from '../types'

/**
 * The MessageProcessor consumes blocks of parsed messages emitted by the
 * ConnectionEndpoint, checks if they are permissioned and - if they
 * are - forwards them.
 */
export default class MessageProcessor {
  private bulkResults = new Map<string, { total: number, completed: number }>()

  constructor (config: DeepstreamConfig, private services: DeepstreamServices) {
    this.onPermissionResponse = this.onPermissionResponse.bind(this)
    this.onBulkPermissionResponse = this.onBulkPermissionResponse.bind(this)
  }

  /**
   * There will only ever be one consumer of forwarded messages. So rather than using
   * events - and their performance overhead - the messageProcessor exposes
   * this method that's expected to be overwritten.
   */
  public onAuthenticatedMessage (socketWrapper: SocketWrapper, message: Message) {
  }

  /**
   * This method is the way the message processor accepts input. It receives arrays
   * of parsed messages, iterates through them and issues permission requests for
   * each individual message
   *
   * @todo The responses from the permission service might arrive in any arbitrary order - order them
   * @todo Handle permission handler timeouts
   */
  public process (socketWrapper: SocketWrapper, parsedMessages: Message[]): void {
    const length = parsedMessages.length
    for (let i = 0; i < length; i++) {
      const message = parsedMessages[i]

      if (message.topic === TOPIC.CONNECTION && message.action === CONNECTION_ACTIONS.PING) {
        // Each connection endpoint is responsible for dealing with ping connections
        continue
      }

      if (message.isBulk) {
        if (this.bulkResults.has(message.correlationId!)) {
          this.services.logger.error(EVENT.NOT_VALID_UUID, `Invalid uuid used twice ${message.correlationId}`)
        }

        this.bulkResults.set(message.correlationId!, {
          total: message.names!.length,
          completed: 0
        })
        const action = BULK_ACTIONS[message.topic][message.action]
        const l = message.names!.length
        for (let j = 0; j < l; j++) {
          this.services.permission.canPerformAction(
            socketWrapper.user,
            { ...message, action, name: message.names![j] },
            this.onBulkPermissionResponse,
            socketWrapper.authData!,
            socketWrapper,
            { originalMessage: message }
          )
        }
        return
      }

      this.services.permission.canPerformAction(
        socketWrapper.user,
        message,
        this.onPermissionResponse,
        socketWrapper.authData!,
        socketWrapper,
        {}
      )
    }
  }

  private onBulkPermissionResponse (socketWrapper: SocketWrapper, message: Message, passItOn: any, error: ALL_ACTIONS | Error | string | null, result: boolean) {
    const bulkResult = this.bulkResults.get(message.correlationId!)!

    if (error !== null || result === false) {
      passItOn.originalMessage.names!.splice(passItOn.originalMessage.names!.indexOf(passItOn.originalMessage.name!), 1)
      this.processInvalidResponse(socketWrapper, message, error, result)
    }

    if (bulkResult.total !== bulkResult.completed + 1) {
      bulkResult.completed = bulkResult.completed + 1
      return
    }

    this.bulkResults.delete(message.correlationId!)

    if (message.names!.length > 0) {
      this.onAuthenticatedMessage(socketWrapper, passItOn.originalMessage)
    }
  }

  /**
   * Processes the response that's returned by the permission service.
   */
  private onPermissionResponse (socketWrapper: SocketWrapper, message: Message, passItOn: any, error: ALL_ACTIONS | Error | string | null, result: boolean): void {
    if (error !== null || result === false) {
      this.processInvalidResponse(socketWrapper, message, error, result)
    } else {
      this.onAuthenticatedMessage(socketWrapper, message)
    }
  }

  private processInvalidResponse (socketWrapper: SocketWrapper, message: Message, error: ALL_ACTIONS | Error | string | null, result: boolean) {
    if (error !== null) {
      this.services.logger.warn(EVENT_ACTIONS[EVENT_ACTIONS.MESSAGE_PERMISSION_ERROR], error.toString())
      const permissionErrorMessage: Message = {
        topic: message.topic,
        action: EVENT_ACTIONS.MESSAGE_PERMISSION_ERROR,
        originalAction: message.action,
        name: message.name
      }
      if (message.correlationId) {
        permissionErrorMessage.correlationId = message.correlationId
      }
      socketWrapper.sendMessage(permissionErrorMessage)
      return
    }

    if (result !== true) {
      const permissionDeniedMessage: Message = {
        topic: message.topic,
        action: EVENT_ACTIONS.MESSAGE_DENIED,
        originalAction: message.action,
        name: message.name
      }
      if (message.correlationId) {
        permissionDeniedMessage.correlationId = message.correlationId
      }
      socketWrapper.sendMessage(permissionDeniedMessage)
      return
    }
  }
}