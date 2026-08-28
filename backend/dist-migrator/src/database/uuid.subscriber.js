"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UuidSubscriber = void 0;
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
/** SQLite 没有 PostgreSQL 的 uuid 默认函数；由应用在插入前统一补齐 UUID。 */
let UuidSubscriber = class UuidSubscriber {
    beforeInsert(event) {
        const entity = event.entity;
        if (entity && !entity.id && event.metadata.primaryColumns.some((column) => column.propertyName === 'id')) {
            entity.id = (0, crypto_1.randomUUID)();
        }
    }
};
exports.UuidSubscriber = UuidSubscriber;
exports.UuidSubscriber = UuidSubscriber = __decorate([
    (0, typeorm_1.EventSubscriber)()
], UuidSubscriber);
