var EventSourcedAggregate = require('./EventSourcedAggregate').EventSourcedAggregate;
var Event = require('./Event').Event;
var util = require('util');
var when = require('when');

function SagaStage(name, accumulatorFunction){
	this.name = name;
	this.transitions = {};
}
SagaStage.prototype.addTransition = function addTransition(transition){
	this.transitions[transition.name] = transition;
	// Allow method chaining.
	return this;
};
SagaStage.prototype.handleEvent = function handleEvent(event, commit, queuedEvents, accumulator){
	var specificMethodName = 'on' + event.eventType;
	if(typeof(this[specificMethodName]) === 'function'){
		this[specificMethodName](event, commit, queuedEvents, accumulator);
	}
	else{
		if(typeof(this.defaultEventHandler) === 'function'){
			this.defaultEventHandler(event, commit, queuedEvents, accumulator);
		}
	}
};

function SagaTransition(name, eventAcceptorFunction, actionFunction, transitionEventType, eventPayloadGenerator){
	this.destination = null;
	this.eventEndsTransition = eventAcceptorFunction;
	this.performAction = actionFunction;
	this.transitionEventType = transitionEventType;
	this.eventPayloadGenerator = (typeof(eventPayloadGenerator) === 'function') ? eventPayloadGenerator : function(event, commit, queuedEvents, accumulator){};
}

SagaTransition.prototype.setDestination = function setDestination(destination){
	this.destination = destination;
	// Allow method chaining.
	return this;
};

function Saga(){
	
}
util.inherits(Saga, EventSourcedAggregate);

Saga.prototype._init = function _init(initialStage){
	this._currentStage = initialStage;
	this._currentStagePath = 'init';
	this._stageAccumulator = {};
	this._enqueuedEvents = [];
	this._seenEventIDs = {};
	this._error = null;
	this._allowMissingEventHandlers = true;
};

Saga.prototype.processEvent = function processEvent(event, commit){
	var self = this;
	// Guard clause: do not process duplicate events.
	if(this._seenEventIDs[event.eventID]){
		return when.resolve();
	}
	// Gather all transitions that are to occur. We use each transition's supplied decision function.
	var transitionIntents = [];
	for(var transitionKey in this._currentStage.transitions){
		var currentTransition = this._currentStage.transitions[transitionKey];
		var transitionDecision = currentTransition.eventEndsTransition(event, commit, this._enqueuedEvents, this._stageAccumulator);
		if(transitionDecision){
			transitionIntents.push(currentTransition);
		}
	}
	// Check if any transitions have been marked for passing.
	if(transitionIntents.length > 0){
		// There is at least one nominated transition.
		// Check for conflicts.
		if(transitionIntents.length > 1){
			//TODO: define the event payload below in a better way.
			this._stageEvent('TransitionConflictDetected', {currentStage: this._currentStage.name, currentEventType: event.eventType});
			return when.reject(new TransitionConflictError('Transition conflict detected - will not proceed with state transition'));
		}
		var transition = transitionIntents[0];
		return when(transition.performAction(event, commit, this._enqueuedEvents, this._stageAccumulator),
		function _finalizeTransition(actionResult){
			self._stageEvent(new Event(transition.transitionEventType, transition.eventPayloadGenerator(event, commit, self._enqueuedEvents, self._stageAccumulator, actionResult)));
			self._stageEvent(new Event('TransitionCompleted', {transitionName: transition.name}));
			return when.resolve(actionResult);
		},
		function _cancelTransition(reason){
			return when.reject(reason);
		});
	}
	else{
		// No transitions - simply enqueue the event.
		this._stageEvent(new Event('EventEnqueued', {event: event}));
		return when.resolve();
	}
};

Saga.prototype.onEventEnqueued = function onEventEnqueued(event, commit){
	this._enqueuedEvents.push(event);
	this._currentStage.handleEvent(event, commit, this._enqueuedEvents, this._stageAccumulator);
};

Saga.prototype.onTransitionCompleted = function onTransitionCompleted(event, commit){
	var transitionName = event.eventPayload.transitionName;
	this._currentStage = this._currentStage.transitions[transitionName].destination;
	this._currentStagePath += '.' + transitionName;
	this._enqueuedEvents = [];
	this._stageAccumulator = {};
};

Saga.prototype._getSnapshotData = function _getSnapshotData(){
	return {
		stagePath: this._currentStagePath,
		enqueuedEvents: this._enqueuedEvents,
		stageAccumulator: this._stageAccumulator,
		seenEventIDs: Object.keys(this._seenEventIDs)
	};
};

module.exports.SagaStage = SagaStage;
module.exports.SagaTransition = SagaTransition;
module.exports.Saga = Saga;