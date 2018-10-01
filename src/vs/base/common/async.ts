/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import * as errors from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { ErrorCallback, TPromise, ValueCallback } from 'vs/base/common/winjs.base';

export function isThenable<T>(obj: any): obj is Thenable<T> {
	return obj && typeof (<Thenable<any>>obj).then === 'function';
}

export interface CancelablePromise<T> extends Promise<T> {
	cancel(): void;
}

export function createCancelablePromise<T>(callback: (token: CancellationToken) => Thenable<T>): CancelablePromise<T> {
	const source = new CancellationTokenSource();

	const thenable = callback(source.token);
	const promise = new Promise<T>((resolve, reject) => {
		source.token.onCancellationRequested(() => {
			reject(errors.canceled());
		});
		Promise.resolve(thenable).then(value => {
			source.dispose();
			resolve(value);
		}, err => {
			source.dispose();
			reject(err);
		});
	});

	return new class implements CancelablePromise<T> {
		cancel() {
			source.cancel();
		}
		then<TResult1 = T, TResult2 = never>(resolve?: ((value: T) => TResult1 | Thenable<TResult1>) | undefined | null, reject?: ((reason: any) => TResult2 | Thenable<TResult2>) | undefined | null): Promise<TResult1 | TResult2> {
			return promise.then(resolve, reject);
		}
		catch<TResult = never>(reject?: ((reason: any) => TResult | Thenable<TResult>) | undefined | null): Promise<T | TResult> {
			return this.then(undefined, reject);
		}
	};
}

export function asThenable<T>(callback: () => T | Thenable<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let item = callback();
		if (isThenable<T>(item)) {
			item.then(resolve, reject);
		} else {
			resolve(item);
		}
	});
}

export interface ITask<T> {
	(): T;
}

/**
 * A helper to prevent accumulation of sequential async tasks.
 *
 * Imagine a mail man with the sole task of delivering letters. As soon as
 * a letter submitted for delivery, he drives to the destination, delivers it
 * and returns to his base. Imagine that during the trip, N more letters were submitted.
 * When the mail man returns, he picks those N letters and delivers them all in a
 * single trip. Even though N+1 submissions occurred, only 2 deliveries were made.
 *
 * The throttler implements this via the queue() method, by providing it a task
 * factory. Following the example:
 *
 * 		const throttler = new Throttler();
 * 		const letters = [];
 *
 * 		function deliver() {
 * 			const lettersToDeliver = letters;
 * 			letters = [];
 * 			return makeTheTrip(lettersToDeliver);
 * 		}
 *
 * 		function onLetterReceived(l) {
 * 			letters.push(l);
 * 			throttler.queue(deliver);
 * 		}
 */
export class Throttler {

	private activePromise: TPromise;
	private queuedPromise: TPromise;
	private queuedPromiseFactory: ITask<TPromise>;

	constructor() {
		this.activePromise = null;
		this.queuedPromise = null;
		this.queuedPromiseFactory = null;
	}

	queue<T>(promiseFactory: ITask<TPromise<T>>): TPromise<T> {
		if (this.activePromise) {
			this.queuedPromiseFactory = promiseFactory;

			if (!this.queuedPromise) {
				const onComplete = () => {
					this.queuedPromise = null;

					const result = this.queue(this.queuedPromiseFactory);
					this.queuedPromiseFactory = null;

					return result;
				};

				this.queuedPromise = new TPromise(c => {
					this.activePromise.then(onComplete, onComplete).then(c);
				});
			}

			return new TPromise((c, e) => {
				this.queuedPromise.then(c, e);
			});
		}

		this.activePromise = promiseFactory();

		return new TPromise((c, e) => {
			this.activePromise.then((result: any) => {
				this.activePromise = null;
				c(result);
			}, (err: any) => {
				this.activePromise = null;
				e(err);
			});
		});
	}
}

// TODO@Joao: can the previous throttler be replaced with this?
export class SimpleThrottler {

	private current = TPromise.wrap<any>(null);

	queue<T>(promiseTask: ITask<TPromise<T>>): TPromise<T> {
		return this.current = this.current.then(() => promiseTask());
	}
}

/**
 * A helper to delay execution of a task that is being requested often.
 *
 * Following the throttler, now imagine the mail man wants to optimize the number of
 * trips proactively. The trip itself can be long, so he decides not to make the trip
 * as soon as a letter is submitted. Instead he waits a while, in case more
 * letters are submitted. After said waiting period, if no letters were submitted, he
 * decides to make the trip. Imagine that N more letters were submitted after the first
 * one, all within a short period of time between each other. Even though N+1
 * submissions occurred, only 1 delivery was made.
 *
 * The delayer offers this behavior via the trigger() method, into which both the task
 * to be executed and the waiting period (delay) must be passed in as arguments. Following
 * the example:
 *
 * 		const delayer = new Delayer(WAITING_PERIOD);
 * 		const letters = [];
 *
 * 		function letterReceived(l) {
 * 			letters.push(l);
 * 			delayer.trigger(() => { return makeTheTrip(); });
 * 		}
 */
export class Delayer<T> {

	private timeout: number;
	private completionPromise: TPromise;
	private doResolve: ValueCallback;
	private doReject: (err: any) => void;
	private task: ITask<T | TPromise<T>>;

	constructor(public defaultDelay: number) {
		this.timeout = null;
		this.completionPromise = null;
		this.doResolve = null;
		this.task = null;
	}

	trigger(task: ITask<T | TPromise<T>>, delay: number = this.defaultDelay): TPromise<T> {
		this.task = task;
		this.cancelTimeout();

		if (!this.completionPromise) {
			this.completionPromise = new TPromise((c, e) => {
				this.doResolve = c;
				this.doReject = e;
			}).then(() => {
				this.completionPromise = null;
				this.doResolve = null;
				const task = this.task;
				this.task = null;

				return task();
			});
		}

		this.timeout = setTimeout(() => {
			this.timeout = null;
			this.doResolve(null);
		}, delay);

		return this.completionPromise;
	}

	isTriggered(): boolean {
		return this.timeout !== null;
	}

	cancel(): void {
		this.cancelTimeout();

		if (this.completionPromise) {
			this.doReject(errors.canceled());
			this.completionPromise = null;
		}
	}

	private cancelTimeout(): void {
		if (this.timeout !== null) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
	}
}

/**
 * A helper to delay execution of a task that is being requested often, while
 * preventing accumulation of consecutive executions, while the task runs.
 *
 * Simply combine the two mail men's strategies from the Throttler and Delayer
 * helpers, for an analogy.
 */
export class ThrottledDelayer<T> extends Delayer<TPromise<T>> {

	private throttler: Throttler;

	constructor(defaultDelay: number) {
		super(defaultDelay);

		this.throttler = new Throttler();
	}

	trigger(promiseFactory: ITask<TPromise<T>>, delay?: number): TPromise {
		return super.trigger(() => this.throttler.queue(promiseFactory), delay);
	}
}

/**
 * A barrier that is initially closed and then becomes opened permanently.
 */
export class Barrier {

	private _isOpen: boolean;
	private _promise: TPromise<boolean>;
	private _completePromise: (v: boolean) => void;

	constructor() {
		this._isOpen = false;
		this._promise = new TPromise<boolean>((c, e) => {
			this._completePromise = c;
		});
	}

	isOpen(): boolean {
		return this._isOpen;
	}

	open(): void {
		this._isOpen = true;
		this._completePromise(true);
	}

	wait(): TPromise<boolean> {
		return this._promise;
	}
}

/**
 * Replacement for `WinJS.TPromise.timeout`.
 */
export function timeout(millis: number): CancelablePromise<void>;
export function timeout(millis: number, token: CancellationToken): Thenable<void>;
export function timeout(millis: number, token?: CancellationToken): CancelablePromise<void> | Thenable<void> {
	if (!token) {
		return createCancelablePromise(token => timeout(millis, token));
	}

	return new Promise((resolve, reject) => {
		const handle = setTimeout(resolve, millis);
		token.onCancellationRequested(() => {
			clearTimeout(handle);
			reject(errors.canceled());
		});
	});
}

/**
 * Returns a new promise that joins the provided promise. Upon completion of
 * the provided promise the provided function will always be called. This
 * method is comparable to a try-finally code block.
 * @param promise a promise
 * @param callback a function that will be call in the success and error case.
 */
export function always<T>(thenable: TPromise<T>, callback: () => void): TPromise<T>;
export function always<T>(promise: Thenable<T>, callback: () => void): Thenable<T>;
export function always<T>(winjsPromiseOrThenable: Thenable<T>, callback: () => void) {
	function safeCallback() {
		try {
			callback();
		} catch (err) {
			errors.onUnexpectedError(err);
		}
	}
	winjsPromiseOrThenable.then(_ => safeCallback(), _ => safeCallback());
	return winjsPromiseOrThenable;
}

/**
 * Runs the provided list of promise factories in sequential order. The returned
 * promise will complete to an array of results from each promise.
 */

export function sequence<T>(promiseFactories: ITask<Thenable<T>>[]): Promise<T[]> {
	const results: T[] = [];
	let index = 0;
	const len = promiseFactories.length;

	function next(): Thenable<T> | null {
		return index < len ? promiseFactories[index++]() : null;
	}

	function thenHandler(result: any): Thenable<any> {
		if (result !== undefined && result !== null) {
			results.push(result);
		}

		const n = next();
		if (n) {
			return n.then(thenHandler);
		}

		return Promise.resolve(results);
	}

	return Promise.resolve(null).then(thenHandler);
}

export function first<T>(promiseFactories: ITask<Thenable<T>>[], shouldStop: (t: T) => boolean = t => !!t, defaultValue: T = null): Promise<T> {
	let index = 0;
	const len = promiseFactories.length;

	const loop: () => Promise<T> = () => {
		if (index >= len) {
			return Promise.resolve(defaultValue);
		}

		const factory = promiseFactories[index++];
		const promise = Promise.resolve(factory());

		return promise.then(result => {
			if (shouldStop(result)) {
				return Promise.resolve(result);
			}

			return loop();
		});
	};

	return loop();
}

interface ILimitedTaskFactory {
	factory: ITask<TPromise>;
	c: ValueCallback;
	e: ErrorCallback;
}

/**
 * A helper to queue N promises and run them all with a max degree of parallelism. The helper
 * ensures that at any time no more than M promises are running at the same time.
 */
export class Limiter<T> {
	private runningPromises: number;
	private maxDegreeOfParalellism: number;
	private outstandingPromises: ILimitedTaskFactory[];
	private readonly _onFinished: Emitter<void>;

	constructor(maxDegreeOfParalellism: number) {
		this.maxDegreeOfParalellism = maxDegreeOfParalellism;
		this.outstandingPromises = [];
		this.runningPromises = 0;
		this._onFinished = new Emitter<void>();
	}

	public get onFinished(): Event<void> {
		return this._onFinished.event;
	}

	public get size(): number {
		return this.runningPromises + this.outstandingPromises.length;
	}

	queue(promiseFactory: ITask<TPromise>): TPromise;
	queue(factory: ITask<TPromise<T>>): TPromise<T> {
		return new TPromise<T>((c, e) => {
			this.outstandingPromises.push({ factory, c, e });

			this.consume();
		});
	}

	private consume(): void {
		while (this.outstandingPromises.length && this.runningPromises < this.maxDegreeOfParalellism) {
			const iLimitedTask = this.outstandingPromises.shift();
			this.runningPromises++;

			const promise = iLimitedTask.factory();
			promise.then(iLimitedTask.c, iLimitedTask.e);
			promise.then(() => this.consumed(), () => this.consumed());
		}
	}

	private consumed(): void {
		this.runningPromises--;

		if (this.outstandingPromises.length > 0) {
			this.consume();
		} else {
			this._onFinished.fire();
		}
	}

	public dispose(): void {
		this._onFinished.dispose();
	}
}

/**
 * A queue is handles one promise at a time and guarantees that at any time only one promise is executing.
 */
export class Queue<T> extends Limiter<T> {

	constructor() {
		super(1);
	}
}

/**
 * A helper to organize queues per resource. The ResourceQueue makes sure to manage queues per resource
 * by disposing them once the queue is empty.
 */
export class ResourceQueue {
	private queues: { [path: string]: Queue<void> };

	constructor() {
		this.queues = Object.create(null);
	}

	public queueFor(resource: URI): Queue<void> {
		const key = resource.toString();
		if (!this.queues[key]) {
			const queue = new Queue<void>();
			queue.onFinished(() => {
				queue.dispose();
				delete this.queues[key];
			});

			this.queues[key] = queue;
		}

		return this.queues[key];
	}
}

export class TimeoutTimer extends Disposable {
	private _token: number;

	constructor();
	constructor(runner: () => void, timeout: number);
	constructor(runner?: () => void, timeout?: number) {
		super();
		this._token = -1;

		if (typeof runner === 'function' && typeof timeout === 'number') {
			this.setIfNotSet(runner, timeout);
		}
	}

	dispose(): void {
		this.cancel();
		super.dispose();
	}

	cancel(): void {
		if (this._token !== -1) {
			clearTimeout(this._token);
			this._token = -1;
		}
	}

	cancelAndSet(runner: () => void, timeout: number): void {
		this.cancel();
		this._token = setTimeout(() => {
			this._token = -1;
			runner();
		}, timeout);
	}

	setIfNotSet(runner: () => void, timeout: number): void {
		if (this._token !== -1) {
			// timer is already set
			return;
		}
		this._token = setTimeout(() => {
			this._token = -1;
			runner();
		}, timeout);
	}
}

export class IntervalTimer extends Disposable {

	private _token: number;

	constructor() {
		super();
		this._token = -1;
	}

	dispose(): void {
		this.cancel();
		super.dispose();
	}

	cancel(): void {
		if (this._token !== -1) {
			clearInterval(this._token);
			this._token = -1;
		}
	}

	cancelAndSet(runner: () => void, interval: number): void {
		this.cancel();
		this._token = setInterval(() => {
			runner();
		}, interval);
	}
}

export class RunOnceScheduler {

	protected runner: (...args: any[]) => void;

	private timeoutToken: number;
	private timeout: number;
	private timeoutHandler: () => void;

	constructor(runner: (...args: any[]) => void, timeout: number) {
		this.timeoutToken = -1;
		this.runner = runner;
		this.timeout = timeout;
		this.timeoutHandler = this.onTimeout.bind(this);
	}

	/**
	 * Dispose RunOnceScheduler
	 */
	dispose(): void {
		this.cancel();
		this.runner = null;
	}

	/**
	 * Cancel current scheduled runner (if any).
	 */
	cancel(): void {
		if (this.isScheduled()) {
			clearTimeout(this.timeoutToken);
			this.timeoutToken = -1;
		}
	}

	/**
	 * Cancel previous runner (if any) & schedule a new runner.
	 */
	schedule(delay = this.timeout): void {
		this.cancel();
		this.timeoutToken = setTimeout(this.timeoutHandler, delay);
	}

	/**
	 * Returns true if scheduled.
	 */
	isScheduled(): boolean {
		return this.timeoutToken !== -1;
	}

	private onTimeout() {
		this.timeoutToken = -1;
		if (this.runner) {
			this.doRun();
		}
	}

	protected doRun(): void {
		this.runner();
	}
}

export class RunOnceWorker<T> extends RunOnceScheduler {
	private units: T[] = [];

	constructor(runner: (units: T[]) => void, timeout: number) {
		super(runner, timeout);
	}

	work(unit: T): void {
		this.units.push(unit);

		if (!this.isScheduled()) {
			this.schedule();
		}
	}

	protected doRun(): void {
		const units = this.units;
		this.units = [];

		this.runner(units);
	}

	dispose(): void {
		this.units = [];

		super.dispose();
	}
}

export function nfcall(fn: Function, ...args: any[]): TPromise;
export function nfcall<T>(fn: Function, ...args: any[]): TPromise<T>;
export function nfcall(fn: Function, ...args: any[]): any {
	return new TPromise((c, e) => fn(...args, (err: any, result: any) => err ? e(err) : c(result)));
}

export function ninvoke(thisArg: any, fn: Function, ...args: any[]): TPromise;
export function ninvoke<T>(thisArg: any, fn: Function, ...args: any[]): TPromise<T>;
export function ninvoke(thisArg: any, fn: Function, ...args: any[]): any {
	return new TPromise((c, e) => fn.call(thisArg, ...args, (err: any, result: any) => err ? e(err) : c(result)));
}


//#region -- run on idle tricks ------------

export interface IdleDeadline {
	readonly didTimeout: boolean;
	timeRemaining(): DOMHighResTimeStamp;
}
/**
 * Execute the callback the next time the browser is idle
 */
export let runWhenIdle: (callback: (idle: IdleDeadline) => void, timeout?: number) => IDisposable;

declare function requestIdleCallback(callback: (args: IdleDeadline) => void, options?: { timeout: number }): number;
declare function cancelIdleCallback(handle: number): void;

(function () {
	if (typeof requestIdleCallback !== 'function' || typeof cancelIdleCallback !== 'function') {
		let dummyIdle: IdleDeadline = Object.freeze({
			didTimeout: true,
			timeRemaining() { return 15; }
		});
		runWhenIdle = (runner, timeout = 0) => {
			let handle = setTimeout(() => runner(dummyIdle), timeout);
			return { dispose() { clearTimeout(handle); handle = undefined; } };
		};
	} else {
		runWhenIdle = (runner, timeout?) => {
			let handle = requestIdleCallback(runner, typeof timeout === 'number' ? { timeout } : undefined);
			return { dispose() { cancelIdleCallback(handle); handle = undefined; } };
		};
	}
})();

/**
 * An implementation of the "idle-until-urgent"-strategy as introduced
 * here: https://philipwalton.com/articles/idle-until-urgent/
 */
export class IdleValue<T> {

	private readonly _executor: () => void;
	private readonly _handle: IDisposable;

	private _didRun: boolean;
	private _value: T;
	private _error: any;

	constructor(executor: () => T) {
		this._executor = () => {
			try {
				this._value = executor();
			} catch (err) {
				this._error = err;
			} finally {
				this._didRun = true;
			}
		};
		this._handle = runWhenIdle(() => this._executor());
	}

	dispose(): void {
		this._handle.dispose();
	}

	getValue(): T {
		if (!this._didRun) {
			this._handle.dispose();
			this._executor();
		}
		if (this._error) {
			throw this._error;
		}
		return this._value;
	}
}

//#endregion
