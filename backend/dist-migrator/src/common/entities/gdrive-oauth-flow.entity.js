"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GDriveOAuthFlow = void 0;
const typeorm_1 = require("typeorm");
let GDriveOAuthFlow = class GDriveOAuthFlow {
};
exports.GDriveOAuthFlow = GDriveOAuthFlow;
__decorate([
    (0, typeorm_1.PrimaryColumn)('varchar', { length: 64 }),
    __metadata("design:type", String)
], GDriveOAuthFlow.prototype, "stateHash", void 0);
__decorate([
    (0, typeorm_1.Column)('varchar', { length: 64 }),
    __metadata("design:type", String)
], GDriveOAuthFlow.prototype, "bindingHash", void 0);
__decorate([
    (0, typeorm_1.Index)('idx_gdrive_oauth_flows_expires'),
    (0, typeorm_1.Column)('bigint'),
    __metadata("design:type", Number)
], GDriveOAuthFlow.prototype, "expiresAt", void 0);
exports.GDriveOAuthFlow = GDriveOAuthFlow = __decorate([
    (0, typeorm_1.Entity)('gdrive_oauth_flows')
], GDriveOAuthFlow);
