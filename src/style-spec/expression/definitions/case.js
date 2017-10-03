// @flow

const assert = require('assert');
const { BooleanType } = require('../types');

import type { Expression } from '../expression';
import type ParsingContext from '../parsing_context';
import type CompilationContext  from '../compilation_context';
import type EvaluationContext from '../evaluation_context';
import type { Type } from '../types';

type Branches = Array<[Expression, Expression]>;

class Case implements Expression {
    key: string;
    type: Type;

    branches: Branches;
    otherwise: Expression;

    constructor(key: string, type: Type, branches: Branches, otherwise: Expression) {
        this.key = key;
        this.type = type;
        this.branches = branches;
        this.otherwise = otherwise;
    }

    static parse(args: Array<mixed>, context: ParsingContext) {
        if (args.length < 4)
            return context.error(`Expected at least 3 arguments, but found only ${args.length - 1}.`);
        if (args.length % 2 !== 0)
            return context.error(`Expected an odd number of arguments.`);

        let outputType: ?Type;
        if (context.expectedType && context.expectedType.kind !== 'Value') {
            outputType = context.expectedType;
        }

        const branches = [];
        for (let i = 1; i < args.length - 1; i += 2) {
            const test = context.parse(args[i], i, BooleanType);
            if (!test) return null;

            const result = context.parse(args[i + 1], i + 1, outputType);
            if (!result) return null;

            branches.push([test, result]);

            outputType = outputType || result.type;
        }

        const otherwise = context.parse(args[args.length - 1], args.length - 1, outputType);
        if (!otherwise) return null;

        assert(outputType);
        return new Case(context.key, (outputType: any), branches, otherwise);
    }

    compile(ctx: CompilationContext) {
        const branches = this.branches.map(([test, expression]) =>
            [ctx.compileAndCache(test), ctx.compileAndCache(expression)]);
        const otherwise = ctx.compileAndCache(this.otherwise);

        return (ctx: EvaluationContext) => {
            for (const [test, expression] of branches) {
                if (test(ctx)) {
                    return expression(ctx);
                }
            }
            return otherwise(ctx);
        };
    }

    serialize() {
        const result = ['case'];
        for (const [test, expression] of this.branches) {
            result.push(test.serialize());
            result.push(expression.serialize());
        }
        result.push(this.otherwise.serialize());
        return result;
    }

    eachChild(fn: (Expression) => void) {
        for (const [test, expression] of this.branches) {
            fn(test);
            fn(expression);
        }
        fn(this.otherwise);
    }
}

module.exports = Case;
