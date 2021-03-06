//
//
//

// Channel machinery.

'use strict';

var defs = require('./defs');
var closeMsg = require('./format').closeMessage;
var inspect = require('./format').inspect;
var methodName = require('./format').methodName;
var assert = require('assert');
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;
var fmt = require('util').format;
var IllegalOperationError = require('./error').IllegalOperationError;
var stackCapture = require('./error').stackCapture;
var Buffer = require('safe-buffer').Buffer
function Channel(connection) {
  EventEmitter.call( this );
  this.connection = connection;
  // for the presently outstanding RPC
  this.reply = null;
  // for the RPCs awaiting action
  this.pending = [];
  // for unconfirmed messages
  this.lwm = 1; // the least, unconfirmed deliveryTag
  this.unconfirmed = []; // rolling window of delivery callbacks
  this.on('ack', this.handleConfirm.bind(this, function(cb) {
    if (cb) cb(null);
  }));
  this.on('nack', this.handleConfirm.bind(this, function(cb) {
    if (cb) cb(new Error('message nacked'));
  }));
  // message frame state machine
  this.handleMessage = acceptDeliveryOrReturn;
  // Incarnation of a channel. Increases on every recovery.
  this.incarnation = 0;
}
inherits(Channel, EventEmitter);

module.exports.Channel = Channel;
module.exports.acceptMessage = acceptMessage;

var C = Channel.prototype;

C.allocate = function() {
  this.ch = this.connection.freshChannel(this);
  return this;
}

// Incoming frames are either notifications of e.g., message delivery,
// or replies to something we've sent. In general I deal with the
// former by emitting an event, and with the latter by keeping a track
// of what's expecting a reply.
//
// The AMQP specification implies that RPCs can't be pipelined; that
// is, you can have only one outstanding RPC on a channel at a
// time. Certainly that's what RabbitMQ and its clients assume. For
// this reason, I buffer RPCs if the channel is already waiting for a
// reply.

// Just send the damn frame.
C.sendImmediately = function(method, fields) {
  return this.connection.sendMethod(this.ch, method, fields);
};

// Invariant: !this.reply -> pending.length == 0. That is, whenever we
// clear a reply, we must send another RPC (and thereby fill
// this.reply) if there is one waiting. The invariant relevant here
// and in `accept`.
C.sendOrEnqueue = function(method, fields, reply) {
  if (!this.reply) { // if no reply waiting, we can go
    assert(this.pending.length === 0);
    this.reply = reply;
    this.sendImmediately(method, fields);
  }
  else {
    this.pending.push({method: method,
                       fields: fields,
                       reply: reply});
  }
};

C.sendMessage = function(fields, properties, content) {
  return this.connection.sendMessage(
    this.ch,
    defs.BasicPublish, fields,
    defs.BasicProperties, properties,
    content);
};

// Internal, synchronously resolved RPC; the return value is resolved
// with the whole frame.
C._rpc = function(method, fields, expect, cb) {
  var self = this;
  function reply(err, f) {
    if (err === null) {
      if (f.id === expect) {
        return cb(null, f);
      }
      else {
        // We have detected a problem, so it's up to us to close the
        // channel
        var expectedName = methodName(expect);
        var e = new Error(fmt("Expected %s; got %s",
                              expectedName, inspect(f, false)));
        self.closeWithError(fmt('Expected %s; got %s',
                                expectedName, methodName(f.id)),
                            defs.constants.UNEXPECTED_FRAME, e);
        return cb(e);
      }
    }
    // An error will be given if, for example, this is waiting to be
    // sent and the connection closes
    else if (err instanceof Error) return cb(err);
    // A close frame will be given if this is the RPC awaiting reply
    // and the channel is closed by the server
    else {
      // otherwise, it's a close frame
      var closeReason =
        (err.fields.classId << 16) + err.fields.methodId;
      var e = (method === closeReason)
        ? fmt("Operation failed: %s; %s",
              methodName(method), closeMsg(err))
        : fmt("Channel closed by server: %s", closeMsg(err));
      return cb(new Error(e));
    }
  }

  this.sendOrEnqueue(method, fields, reply);
};

// Shutdown protocol. There's three scenarios:
//
// 1. The application decides to shut the channel
// 2. The server decides to shut the channel, possibly because of
// something the application did
// 3. The connection is closing, so there won't be any more frames
// going back and forth.
//
// 1 and 2 involve an exchange of method frames (Close and CloseOk),
// while 3 doesn't; the connection simply says "shutdown" to the
// channel, which then acts as if it's closing, without going through
// the exchange.

function invalidOp(msg, stack) {
  return function() {
    throw new IllegalOperationError(msg, stack);
  };
}

function freezeOp(msg, stack) {
  return function() {
    console.log("Freezed op");
    console.dir(msg);
    // throw new IllegalOperationError(msg, stack);
  };
}

function invalidateSend(ch, msg, stack, freeze) {
  if (freeze === true) {
    ch.sendImmediately = ch.sendOrEnqueue = ch.sendMessage =
      freezeOp(msg, stack);
  } else {
    ch.sendImmediately = ch.sendOrEnqueue = ch.sendMessage =
      invalidOp(msg, stack);
  }
}

function revalidateSend(ch) {
  delete ch.sendImmediately;
  delete ch.sendOrEnqueue;
  delete ch.sendMessage;
  delete ch.accept;
}

C.revalidate = function() {
  this.pending = [];
  this.incarnation = this.incarnation + 1;
  revalidateSend(this);
}

// Move to entirely closed state.
C.toClosed = function(capturedStack, freeze) {
  this._rejectPending();
  invalidateSend(this, 'Channel closed', capturedStack, freeze);
  this.accept = invalidOp('Channel closed', capturedStack);
  this.connection.releaseChannel(this.ch);
  this.emit('close');
};

// Stop being able to send and receive methods and content. Used when
// we close the channel. Invokes the continuation once the server has
// acknowledged the close, but before the channel is moved to the
// closed state.
C.toClosing = function(capturedStack, k) {
  var send = this.sendImmediately.bind(this);
  invalidateSend(this, 'Channel closing', capturedStack);

  this.accept = function(f) {
    if (f.id === defs.ChannelCloseOk) {
      if (k) k();
      var s = stackCapture('ChannelCloseOk frame received');
      this.toClosed(s);
    }
    else if (f.id === defs.ChannelClose) {
      send(defs.ChannelCloseOk, {});
    }
    // else ignore frame
  };
};

C._rejectPending = function() {
  function rej(r) {
    r(new Error("Channel ended, no reply will be forthcoming"));
  }
  if (this.reply !== null) rej(this.reply);
  this.reply = null;

  var discard;
  while (discard = this.pending.shift()) rej(discard.reply);
  this.pending = null; // so pushes will break
};

C.closeBecause = function(reason, code, k) {
  this.sendImmediately(defs.ChannelClose, {
    replyText: reason,
    replyCode: code,
    methodId:0, classId: 0
  });
  var s = stackCapture('closeBecause called: ' + reason);
  this.toClosing(s, k);
};

// If we close because there's been an error, we need to distinguish
// between what we tell the server (`reason`) and what we report as
// the cause in the client (`error`).
C.closeWithError = function(reason, code, error) {
  var self = this;
  this.closeBecause(reason, code, function() {
    error.code = code;
    self.emit('error', error);
  });
};

// A trampolining state machine for message frames on a channel. A
// message arrives in at least two frames: first, a method announcing
// the message (either a BasicDeliver or BasicGetOk); then, a message
// header with the message properties; then, zero or more content
// frames.

// Keep the try/catch localised, in an attempt to avoid disabling
// optimisation
C.acceptMessageFrame = function(f) {
  try {
    this.handleMessage = this.handleMessage(f);
  }
  catch (msg) {
    if (typeof msg === 'string') {
      this.closeWithError(msg, defs.constants.UNEXPECTED_FRAME,
                          new Error(msg));
    }
    else if (msg instanceof Error) {
      this.closeWithError('Error while processing message',
                          defs.constants.INTERNAL_ERROR, msg);
    }
    else {
      this.closeWithError('Internal error while processing message',
                          defs.constants.INTERNAL_ERROR,
                          new Error(msg.toString()));
    }
  }
};

// Kick off a message delivery given a BasicDeliver or BasicReturn
// frame (BasicGet uses the RPC mechanism)
function acceptDeliveryOrReturn(f) {
  var event;
  if (f.id === defs.BasicDeliver) event = 'delivery';
  else if (f.id === defs.BasicReturn) event = 'return';
  else throw fmt("Expected BasicDeliver or BasicReturn; got %s",
                 inspect(f));

  var self = this;
  var fields = f.fields;
  return acceptMessage(function(message) {
    message.fields = fields;
    self.emit(event, message);
  });
}

// Move to the state of waiting for message frames (headers, then
// one or more content frames)
function acceptMessage(continuation) {
  var totalSize = 0, remaining = 0;
  var buffers = null;

  var message = {
    fields: null,
    properties: null,
    content: null
  };

  return headers;

  // expect a headers frame
  function headers(f) {
    if (f.id === defs.BasicProperties) {
      message.properties = f.fields;
      totalSize = remaining = f.size;

      // for zero-length messages, content frames aren't required.
      if (totalSize === 0) {
        message.content = Buffer.alloc(0);
        continuation(message);
        return acceptDeliveryOrReturn;
      }
      else {
        return content;
      }
    }
    else {
      throw "Expected headers frame after delivery";
    }
  }

  // expect a content frame
  // %%% TODO cancelled messages (sent as zero-length content frame)
  function content(f) {
    if (f.content) {
      var size = f.content.length;
      remaining -= size;
      if (remaining === 0) {
        if (buffers !== null) {
          buffers.push(f.content);
          message.content = Buffer.concat(buffers);
        }
        else {
          message.content = f.content;
        }
        continuation(message);
        return acceptDeliveryOrReturn;
      }
      else if (remaining < 0) {
        throw fmt("Too much content sent! Expected %d bytes",
                  totalSize);
      }
      else {
        if (buffers !== null)
          buffers.push(f.content);
        else
          buffers = [f.content];
        return content;
      }
    }
    else throw "Expected content frame after headers"
  }
}

C.handleConfirm = function(handle, f) {
  var tag = f.deliveryTag;
  var multi = f.multiple;

  if (multi) {
    var confirmed = this.unconfirmed.splice(0, tag - this.lwm + 1);
    this.lwm = tag + 1;
    confirmed.forEach(handle);
  }
  else {
    var c;
    if (tag === this.lwm) {
      c = this.unconfirmed.shift();
      this.lwm++;
      // Advance the LWM and the window to the next non-gap, or
      // possibly to the end
      while (this.unconfirmed[0] === null) {
        this.unconfirmed.shift();
        this.lwm++;
      }
    }
    else {
      c = this.unconfirmed[tag - this.lwm];
      this.unconfirmed[tag - this.lwm] = null;
    }
    // Technically, in the single-deliveryTag case, I should report a
    // protocol breach if it's already been confirmed.
    handle(c);
  }
};

C.pushConfirmCallback = function(cb) {
  // `null` is used specifically for marking already confirmed slots,
  // so I coerce `undefined` and `null` to false; functions are never
  // falsey.
  this.unconfirmed.push(cb || false);
};

// Interface for connection to use

C.accept = function(f) {

  switch (f.id) {

    // Message frames
  case undefined: // content frame!
  case defs.BasicDeliver:
  case defs.BasicReturn:
  case defs.BasicProperties:
    return this.acceptMessageFrame(f);

    // confirmations, need to do confirm.select first
  case defs.BasicAck:
    return this.emit('ack', f.fields);
  case defs.BasicNack:
    return this.emit('nack', f.fields);
  case defs.BasicCancel:
    // The broker can send this if e.g., the queue is deleted.
    return this.emit('cancel', f.fields);

  case defs.ChannelClose:
    // Any remote closure is an error to us. Reject the pending reply
    // with the close frame, so it can see whether it was that
    // operation that caused it to close.
    if (this.reply) {
      var reply = this.reply; this.reply = null;
      reply(f);
    }
    var emsg = "Channel closed by server: " + closeMsg(f);
    this.sendImmediately(defs.ChannelCloseOk, {});

    var error = new Error(emsg);
    error.code = f.fields.replyCode;
    this.emit('error', error);

    var s = stackCapture(emsg);
    this.toClosed(s);
    return;

  case defs.BasicFlow:
    // RabbitMQ doesn't send this, it just blocks the TCP socket
    return this.closeWithError("Flow not implemented",
                               defs.constants.NOT_IMPLEMENTED,
                               new Error('Flow not implemented'));

  default: // assume all other things are replies
    // Resolving the reply may lead to another RPC; to make sure we
    // don't hold that up, clear this.reply
    var reply = this.reply; this.reply = null;
    // however, maybe there's an RPC waiting to go? If so, that'll
    // fill this.reply again, restoring the invariant. This does rely
    // on any response being recv'ed after resolving the promise,
    // below; hence, I use synchronous defer.
    if (this.pending.length > 0) {
      var send = this.pending.shift();
      this.reply = send.reply;
      this.sendImmediately(send.method, send.fields);
    }
    return reply(null, f);
  }
};

C.onBufferDrain = function() {
  this.emit('drain');
};


// This adds just a bit more stuff useful for the APIs, but not
// low-level machinery.
function BaseChannel(connection) {
  Channel.call(this, connection);
  this.consumers = {};
}
inherits(BaseChannel, Channel);

module.exports.BaseChannel = BaseChannel;

// Not sure I like the ff, it's going to be changing hidden classes
// all over the place. On the other hand, whaddya do.
BaseChannel.prototype.registerConsumer = function(tag, callback) {
  this.consumers[tag] = callback;
};

BaseChannel.prototype.unregisterConsumer = function(tag) {
  delete this.consumers[tag];
};

function cloneObject(oldObject){
  var newObject = {};
  for(var key in oldObject){
    if(oldObject.hasOwnProperty(key)){
      if(Array.isArray(oldObject[key])){
        newObject[key] = oldObject[key].slice();
      } else {
        newObject[key] = oldObject[key];
      }
    }
  }
  return newObject;
}

BaseChannel.prototype.recordConsumer = function(tag, queue, callback, options) {
  this.ensureConsumersBooked();
  // Manually clone the options object.
  var saved_options = cloneObject(options);
  this.book.consumers[tag] = {queue: queue, callback: callback, options: saved_options};
};

BaseChannel.prototype.removeConsumer = function(tag) {
  this.ensureConsumersBooked();
  delete this.book.consumers[tag];
};

BaseChannel.prototype.ensureConsumersBooked = function() {
  if(this.book === undefined) {
    this.book = {};
  }
  if(this.book.consumers === undefined) {
    this.book.consumers = {};
  }
};

BaseChannel.prototype.recordPrefetch = function(count, global) {
  this.ensurePrefetchBooked();
  this.book.prefetch = {count: count, global: global};
};

BaseChannel.prototype.ensurePrefetchBooked = function() {
  if(this.book === undefined) {
    this.book = {};
  }
};

BaseChannel.prototype.recordQueue = function(queue, anonymous, options) {
  // Do not record internal queues
  if("amq." !== queue.substring(0, 4) || anonymous === true) {
    this.ensureQueuesBooked();
    var saved_options = cloneObject(options);
    this.book.queues[queue] = {anonymous: anonymous, options: saved_options};
  }
};

BaseChannel.prototype.removeQueue = function(queue) {
  this.ensureQueuesBooked();
  this.cleanQueueConsumers(queue);
  this.cleanQueueBindings(queue);
  delete this.book.queues[queue]
};

BaseChannel.prototype.ensureQueuesBooked = function() {
  if(this.book === undefined) {
    this.book = {};
  }
  if(this.book.queues === undefined) {
    this.book.queues = {};
  }
};

BaseChannel.prototype.recordExchange = function(exchange, type, options) {
  // Do not record internal exchanges
  if("amq." !== exchange.substring(0, 4)) {
    this.ensureExchangesBooked();
    var saved_options = cloneObject(options);
    this.book.exchanges[exchange] = {type: type, options: saved_options};
  }
};

BaseChannel.prototype.removeExchange = function(exchange) {
  this.ensureExchangesBooked();
  this.cleanExchangeBindings(exchange);
  delete this.book.exchanges[exchange]
};

BaseChannel.prototype.ensureExchangesBooked = function() {
  if(this.book === undefined) {
    this.book = {};
  }
  if(this.book.exchanges === undefined) {
    this.book.exchanges = {};
  }
};

BaseChannel.prototype.recordBinding = function(type, destination, source, pattern, args) {
  this.ensureBindingsBooked();
  var saved_args = cloneObject(args);
  this.removeBinding(type, destination, source, pattern, args);
  this.book.bindings.push({ source: source,
                            destination: destination,
                            destination_type: type,
                            pattern: pattern, args:
                            saved_args});
};

BaseChannel.prototype.removeBinding = function(type, destination, source, pattern, args) {
  this.ensureBindingsBooked();
  this.book.bindings = this.book.bindings.filter(function(element){
    return !(element.destination_type == type &&
             element.destination == destination &&
             element.source == source &&
             element.pattern == pattern &&
             equalArgs(element.args, args));
  });
};

function equalArgs(args1, args2) {
  for(var key in args1) {
    if(args1.hasOwnProperty(key)) {
      if(args1[key] !== args2[key]) {
        if(Array.isArray(args1[key])) {
          return equalArgs(args1[key], args2[key]);
        } else {
          return false;
        }
      }
    }
  }
  return true;
}

BaseChannel.prototype.ensureBindingsBooked = function() {
  if(this.book === undefined) {
    this.book = {};
  }
  if(this.book.bindings === undefined) {
    this.book.bindings = [];
  }
};

BaseChannel.prototype.renameQueue = function(old_name, new_name) {
  this.ensureBindingsBooked();
  this.ensureConsumersBooked();
  this.ensureQueuesBooked();
  this.book.bindings = this.book.bindings.map(function(binding){
    if(binding.destination_type === "queue" && binding.destination === old_name){
      binding.destination = new_name;
    }
    return binding;
  });
  var consumer_tags = Object.keys(this.book.consumers);
  for(var i = 0; i < consumer_tags.length; i++){
    if(this.book.consumers[consumer_tags[i]].queue === old_name){
      this.book.consumers[consumer_tags[i]].queue = new_name;
    }
  }

  for(var qname in this.book.queues){
    if(this.book.queues.hasOwnProperty(qname) && qname == old_name){
      this.book.queues[new_name] = this.book.queues[old_name];
    }
  }
  delete this.book.queues[old_name];
}

BaseChannel.prototype.cleanQueueConsumers = function(queue) {
  this.ensureConsumersBooked();
  var consumer_tags = Object.keys(this.book.consumers);
  for(var i = 0; i < consumer_tags.length; i++) {
    if(this.book.consumers[consumer_tags[i]].queue === queue){
      delete this.book.consumers[consumer_tags[i]];
    }
  }
}

BaseChannel.prototype.cleanQueueBindings = function(queue) {
  this.ensureBindingsBooked();
  this.book.binding = this.book.bindings.filter(function(binding){
    if(binding.destination_type === "queue" && binding.destination === queue){
      return false;
    } else {
      return true;
    }
  });
}

BaseChannel.prototype.cleanExchangeBindings = function(exchange) {
  this.ensureBindingsBooked();
  this.book.bindings = this.book.bindings.filter(function(binding){
    // Clean exchange binding to the exchange
    if(binding.destination_type === "exchange" && binding.destination === exchange){
      return false;
    // Clean all binding from the exchange
    } else if (binding.source === exchange) {
      return false;
    } else {
      return true;
    }
  });
}

BaseChannel.prototype.dispatchMessage = function(fields, message) {
  var consumerTag = fields.consumerTag;
  var consumer = this.consumers[consumerTag];
  if (consumer) {
    return consumer(message);
  }
  else {
    // %%% Surely a race here
    throw new Error("Unknown consumer: " + consumerTag);
  }
};

BaseChannel.prototype.handleDelivery = function(message) {
  // Add channel incarnation to the message in order to filter acks from older incarnations.
  message.incarnation = this.incarnation;
  return this.dispatchMessage(message.fields, message);
};

BaseChannel.prototype.handleCancel = function(fields) {
  var consumerTag = fields.consumerTag;
  var dispatchResult = this.dispatchMessage(fields, null);
  this.removeConsumer(consumerTag);
  return dispatchResult;
};
