var Fiber = require('fibers');
// TODO: make me use an ES6 generator

/**
 * Abstraction for a sequence, inspired by lazy evaluation and scala collections. Operations on a sequence can
 * return an {RIterable}, defined with certain preconditions. The resulting {RIterable} will yield results either
 * through iterable callbacks, or a final accumulator callback when their methods are invoked. Multiple {RIterables}
 * can be spawned (defined) concurrently, however {RIterable} methods must not be invoked concurrently!
 *
 * @param reader
 * @param Constructor
 * @constructor
 */
function RSequencer (reader, Constructor) {
  var self = this;

  var context = {
    iterRef: undefined, //undefined on init, can be set by RIterable
    finalCallback: undefined, //same as above
    _isSafe: true, //cannot have two RIterables from the same RSequence running at the same time
    fiberExhausted: false //sequence is exhausted
  };

  /**
   * Default next item getter. Does serialization inline
   * @param iterRef
   */
  var nextItemDefault = function (iterRef) {
    reader.next(function (line) {
      iterRef(new Constructor(line));
    });
  };

  /**
   * When used instead of the nextItemDefault, ensures that the item that broke the takeWhile precondition will be
   * considered on the next operation on the sequence.
   *
   * @param obj
   * @returns {Function}
   */
  var getNextItemHijackedFunction = function (obj) {
    return function (iterRef) {
      //restore defaults
      nextItem = nextItemDefault;
      hasNext = reader.hasNext;

      iterRef(obj);
    };
  };

  var hasNextHijacked = function ()  {
    return true;
  };

  //defaults, can be overwritten
  var nextItem = nextItemDefault,
    hasNext = reader.hasNext;

  //main fiber co-routine
  var fiber = Fiber(function () {
    while (hasNext()) {
      nextItem(context.iterRef);
      Fiber.yield();
    }

    context.fiberExhausted = true;

    if (context.finalCallback && context.finalCallback instanceof Function) {
      context.finalCallback();
    }
  });

  /**
   * Peeks at the top value of the sequence. Keeps sequence intact
   *
   * @param {Function} cb
   */
  self.peek = function (cb) {

    context.iterRef = function (obj) {
      nextItem = getNextItemHijackedFunction(obj);
      hasNext = hasNextHijacked;

      cb(obj);
    };

    //in case it is about to get exhausted
    context.finalCallback = cb;

    if (context.fiberExhausted) {
      cb (null);
    } else {
      fiber.run();
    }
  };

  /**
   * Returns a {RIterable} over the remaining items in the sequence until precondition evaluates to false. Falesy value
   * will be preserved in the parent {RSequence}
   *
   * @param {function} precondition , tests each item in the sequence, returns boolean
   * @returns {RIterable}
   */
  self.takeWhile = function (precondition) {

    var _precondition = function (obj) {

      var ret = precondition(obj);

      if (!ret) { //the precondition will fail, need to save the object somehow
        nextItem = getNextItemHijackedFunction(obj);
        hasNext = hasNextHijacked;
      }

      return ret;
    }

    return new RIterable (fiber, context, _precondition);
  };

  /**
   * Returns a {RIterable} over the next {numToTake} items in the sequence.
   * Note: This is relatively unelegant since it deserializes the item following the last item when it doesn't have to.
   * Changing it over is possible, but the core will need to be refactored.'
   *
   * @param numToTake
   * @returns {RIterable}
   */
  self.take = function (numToTake) {
    return self.takeWhile(function () {return numToTake-- > 0});
  };


  /**
   * Returns a {RIterable} over all the remaining items in the sequence
   *
   * @returns {RIterable}
   */
  self.takeAll = function () {
    return new RIterable (fiber, context, null);
  };

};


/**
 * A iterable section of a sequence. An RIterable can have a precondition
 *
 * @param fiber
 * @param context
 * @param precondition
 * @constructor
 */
function RIterable (fiber, context, precondition) {
  var self = this;

  function asyncTick() {
    setImmediate(fiber.run);
  };

  function boilerPlate (finalCallback, this_context) {
    if (!context._isSafe) {
      console.error('ConcurrencyException! unsafe to use!');
      throw 'ConcurrencyException! unsafe to use!';
    }
    context._isSafe = false;

    if (context.fiberExhausted) {
      context._isSafe = true;
      finalCallback.call(this_context, null);
    } else {

      context.finalCallback = function (result) {
        context._isSafe = true;
        if (finalCallback && finalCallback instanceof Function) {
          finalCallback.call(this_context, result);
        }
      };

      asyncTick();
    }
  };

  /**
   * Iterates over elements in the sequence
   *
   * @param {Function} iterFunc
   * @param {Function} finalCallback
   */
  self.each = function (iterFunc, finalCallback) {

    //set the iterable with precondition
    if (precondition) {
      context.iterRef = function (obj) {
        if (precondition(obj)) {
          iterFunc(obj);
          asyncTick();
        } else {
          context.finalCallback(obj);
        }
      };
    } else { //iterate until exhaustion
      context.iterRef = function (obj) {
        iterFunc(obj);
        asyncTick();
      }
    }

    boilerPlate(finalCallback, this);
  };

  /**
   * Seeks until the {precondition} is untrue. Does nothing with the enumerated objects
   *
   * @param finalCallback
   */
  self.seek = function (finalCallback) {
    if (!precondition) console.error('must be used with precondition');

    context.iterRef = function (obj) {
      if (precondition(obj)) {
        asyncTick();
      } else {
        context.finalCallback(obj);
      }
    }

    boilerPlate(finalCallback, this);
  }


  /**
   * Maps the results of the sequence to an array, with a {iterFunc} transformation on each object, passed to
   * {finalCallback}
   *
   * @param {Function} iterFunc
   * @param {Function} finalCallback
   */
  self.map = function (iterFunc, finalCallback) {

    var accumulatorArray = [];

    //set the iterable with precondition
    if (precondition) {
      context.iterRef = function (obj) {
        if (precondition(obj)) {
          accumulatorArray.push(iterFunc(obj));
          asyncTick();
        } else {
          context.finalCallback(accumulatorArray);
        }
      };
    } else { //iterate until exhaustion
      context.iterRef = function (obj) {
        accumulatorArray.push(iterFunc(line));
        asyncTick();
      }

      var prevFinal = context.finalCallback;
      context.finalCallback = function () {
        prevFinal(accumulatorArray);
      };
    }

    boilerPlate(finalCallback, this);

  };

  /**
   * Joins the results of the sequence into an array, passed to {finalCallback}
   *
   * @param {Function} finalCallback
   */
  self.join = function (finalCallback) {

    var accumulatorArray = [];

    //set the iterable with precondition
    if (precondition) {
      context.iterRef = function (obj) {
        if (precondition(obj)) {
          accumulatorArray.push(obj);
          asyncTick();
        } else {
          context.finalCallback(accumulatorArray);
        }
      };
    } else { //iterate until exhaustion
      context.iterRef = function (obj) {
        accumulatorArray.push(obj);
        asyncTick();
      }
      var prevFinal = context.finalCallback;
      context.finalCallback = function () {
        prevFinal(accumulatorArray);
      };
    }

    boilerPlate(finalCallback, this);
  }

};

module.exports = RSequencer;
