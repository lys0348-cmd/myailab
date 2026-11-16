"""시험용 pydantic 대역: 선언된 필드를 그대로 속성으로 담는다."""


class ValidationError(Exception):
    pass


class _FieldInfo:
    def __init__(self, kwargs):
        self.default = kwargs.get("default")
        self.default_factory = kwargs.get("default_factory")

    def make(self):
        return self.default_factory() if self.default_factory else self.default


def Field(**kwargs):
    return _FieldInfo(kwargs)


class BaseModel:
    def __init__(self, **values):
        for name in self.__annotations__:
            # 기본값이 있는 필드는 빠져도 된다.
            if name in values:
                value = values[name]
            else:
                value = getattr(type(self), name)
            if isinstance(value, _FieldInfo):
                value = value.make()
            setattr(self, name, value)

    def model_dump(self):
        def dump(value):
            if isinstance(value, BaseModel):
                return value.model_dump()
            if isinstance(value, list):
                return [dump(item) for item in value]
            return value
        return {name: dump(getattr(self, name)) for name in self.__annotations__}
